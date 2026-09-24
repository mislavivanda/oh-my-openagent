import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import { completedLookupModel, completedReuseKey } from "./intent-routing-turn-record"
import type { IntentRoutingTurnInput, LiveIntentRoutingTurn } from "./intent-routing-turn-store-types"

type PendingGroup = {
  readonly kind: "pending"
  readonly turns: Set<LiveIntentRoutingTurn>
  readonly timer: ReturnType<typeof setTimeout>
}
type FilledReference = { readonly kind: "filled"; readonly turn: LiveIntentRoutingTurn }
type ReuseEntry = PendingGroup | FilledReference

const FAILED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "failed",
  unavailableReason: "transport_error",
  resolvedModel: null,
  latencyMs: 0,
  truncatedInput: false,
  answers: null,
  labels: null,
  invalidAnswerCount: 0,
  questionVersion: 0,
}

export function createIntentRoutingPredictionCache(onTerminalSealed: (turn: LiveIntentRoutingTurn) => void) {
  const entries = new Map<string, ReuseEntry>()

  const applyResult = (turn: LiveIntentRoutingTurn, result: IntentRoutingDecisionResult): void => {
    const isSealed = turn.state === "sealed"
    turn.predictionStatus = result.predictionStatus
    if (!isSealed) turn.state = result.predictionStatus === "filled" ? "prediction_filled" : "prediction_failed"
    turn.unavailableReason = result.unavailableReason
    turn.resolvedModel = result.resolvedModel
    turn.latencyMs = result.latencyMs
    turn.answers = result.answers
    turn.invalidAnswerCount = result.invalidAnswerCount
    if (result.predictionStatus === "filled" && result.resolvedModel !== null && result.answers !== null) {
      turn.reuseKey = completedReuseKey(turn.dedupKey, result.resolvedModel)
      entries.set(`filled:${turn.reuseKey}`, { kind: "filled", turn })
    }
    if (isSealed && turn.correlationWindowClosed) onTerminalSealed(turn)
  }

  const settleGroup = (key: string, group: PendingGroup, result: IntentRoutingDecisionResult): void => {
    if (entries.get(key) !== group) return
    clearTimeout(group.timer)
    entries.delete(key)
    for (const turn of group.turns) {
      if (turn.predictionStatus === "pending" && turn.state !== "evicted") applyResult(turn, result)
    }
  }

  const dispatchFresh = (
    key: string,
    turn: LiveIntentRoutingTurn,
    input: IntentRoutingTurnInput,
    dispatch: () => Promise<IntentRoutingDecisionResult>,
  ): void => {
    let group: PendingGroup
    const timer = setTimeout(() => {
      if (entries.get(key) !== group) return
      entries.delete(key)
      for (const waiting of group.turns) {
        if (waiting.predictionStatus !== "pending" || waiting.state === "evicted") continue
        const isSealed = waiting.state === "sealed"
        waiting.predictionStatus = "timeout"
        if (!isSealed) waiting.state = "prediction_timeout"
        if (isSealed && waiting.correlationWindowClosed) onTerminalSealed(waiting)
      }
    }, input.predictionTimeoutMs)
    timer.unref()
    group = { kind: "pending", turns: new Set([turn]), timer }
    entries.set(key, group)
    let pending: Promise<IntentRoutingDecisionResult>
    try {
      pending = dispatch()
    } catch {
      pending = Promise.resolve(FAILED_RESULT)
    }
    void pending.then(
      (result) => settleGroup(key, group, result),
      () => settleGroup(key, group, FAILED_RESULT),
    )
  }

  return {
    get size() { return entries.size },
    dispatch(turn: LiveIntentRoutingTurn, input: IntentRoutingTurnInput): void {
      const pendingKey = `pending:${turn.dedupKey}`
      const pending = entries.get(pendingKey)
      if (pending?.kind === "pending") {
        turn.predictionReused = true
        pending.turns.add(turn)
        return
      }
      const lookupModel = completedLookupModel(input)
      const completed = lookupModel === undefined
        ? undefined
        : entries.get(`filled:${completedReuseKey(turn.dedupKey, lookupModel)}`)
      if (completed?.kind === "filled" && completed.turn.predictionStatus === "filled") {
        turn.predictionReused = true
        applyResult(turn, {
          predictionStatus: "filled",
          unavailableReason: completed.turn.unavailableReason,
          resolvedModel: completed.turn.resolvedModel,
          latencyMs: completed.turn.latencyMs,
          truncatedInput: completed.turn.truncatedInput,
          answers: completed.turn.answers,
          labels: null,
          invalidAnswerCount: completed.turn.invalidAnswerCount,
          questionVersion: completed.turn.questionVersion,
        })
        return
      }
      if (input.dispatch === undefined) {
        turn.predictionStatus = "not_dispatched"
        turn.state = "not_dispatched"
        turn.notDispatchedReason = input.notDispatchedReason ?? "not_dispatched"
        return
      }
      dispatchFresh(pendingKey, turn, input, input.dispatch)
    },
    remove(turn: LiveIntentRoutingTurn): void {
      for (const [key, entry] of entries) {
        if (entry.kind === "filled" && entry.turn === turn) entries.delete(key)
        if (entry.kind === "pending" && entry.turns.delete(turn) && entry.turns.size === 0) {
          clearTimeout(entry.timer)
          entries.delete(key)
        }
      }
    },
    clear(): void {
      for (const entry of entries.values()) if (entry.kind === "pending") clearTimeout(entry.timer)
      entries.clear()
    },
  }
}
