import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import { EMPTY_INTENT_ROUTING_ANSWERS } from "./intent-routing-turn-record"
import { applyResult, applyTimeout } from "./intent-routing-turn-runtime"
import type { MutableTurn, PendingGroup, TurnStoreState } from "./intent-routing-turn-types"

function transportFailure(turn: MutableTurn, latencyMs: number): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed",
    unavailableReason: "transport_error",
    resolvedModel: null,
    latencyMs,
    answers: {
      intent: { ...EMPTY_INTENT_ROUTING_ANSWERS.intent, label: "would_fall_through" },
      category: { ...EMPTY_INTENT_ROUTING_ANSWERS.category, label: "would_fall_through" },
      subagent: { ...EMPTY_INTENT_ROUTING_ANSWERS.subagent, label: "would_fall_through" },
      ambiguous: EMPTY_INTENT_ROUTING_ANSWERS.ambiguous,
    },
    invalidAnswerCount: 0,
    truncatedInput: false,
    threshold: turn.confidenceThreshold,
    questionVersion: turn.questionVersion,
  }
}

export function completePendingGroup(
  state: TurnStoreState,
  group: PendingGroup,
  result: IntentRoutingDecisionResult | undefined,
): void {
  if (!group.active) return
  group.active = false
  if (group.timer !== undefined) clearTimeout(group.timer)
  group.timer = undefined
  if (state.pendingByTierOne.get(group.tierOneKey) === group) {
    state.pendingByTierOne.delete(group.tierOneKey)
  }
  const records = [...group.records]
  group.records.clear()
  for (const turn of records) {
    turn.pendingGroup = undefined
    if (turn.terminalState === "evicted") continue
    if (result === undefined) applyTimeout(state, turn, state.now() - group.startedAt)
    else applyResult(state, turn, result)
  }
}

export function beginDispatch(
  state: TurnStoreState,
  turn: MutableTurn,
  dispatch: () => Promise<IntentRoutingDecisionResult>,
): void {
  const group: PendingGroup = {
    tierOneKey: turn.dedupKey,
    records: new Set([turn]),
    startedAt: state.now(),
    active: true,
    timer: undefined,
  }
  turn.pendingGroup = group
  state.pendingByTierOne.set(turn.dedupKey, group)
  group.timer = setTimeout(
    () => completePendingGroup(state, group, undefined),
    state.predictionTimeoutMs,
  )
  group.timer.unref?.()

  let dispatched: Promise<IntentRoutingDecisionResult>
  try {
    dispatched = dispatch()
  } catch {
    completePendingGroup(state, group, transportFailure(turn, state.now() - group.startedAt))
    return
  }
  void dispatched.then(
    (result) => completePendingGroup(state, group, result),
    () => completePendingGroup(
      state,
      group,
      transportFailure(turn, state.now() - group.startedAt),
    ),
  )
}

export function reusableTurn(state: TurnStoreState, reuseKey: string): MutableTurn | undefined {
  const candidates = state.completedByTierTwo.get(reuseKey)
  if (candidates === undefined) return undefined
  let latest: MutableTurn | undefined
  for (const candidate of candidates) {
    if (candidate.predictionState !== "filled" || candidate.terminalState === "evicted") continue
    if (latest === undefined || candidate.turnOrdinal > latest.turnOrdinal) latest = candidate
  }
  return latest
}

export function coalescePending(turn: MutableTurn, group: PendingGroup): void {
  turn.pendingGroup = group
  group.records.add(turn)
}
