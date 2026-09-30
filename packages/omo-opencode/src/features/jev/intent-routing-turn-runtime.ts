import type {
  IntentRoutingCounterDelta,
  IntentRoutingDecisionResult,
} from "@oh-my-opencode/jev-core"
import { buildIntentRoutingTierTwoKey } from "./intent-routing-turn-keys"
import { cacheCompletedPrediction } from "./intent-routing-completed-cache"
import {
  buildObservationRecord,
  EMPTY_INTENT_ROUTING_ANSWERS,
  predictionAnswers,
  snapshotCounters,
} from "./intent-routing-turn-record"
import type { CompletedPrediction, MutableTurn, TurnStoreState } from "./intent-routing-turn-types"

export function touchTurn(state: TurnStoreState, turn: MutableTurn): void {
  state.clocks.access += 1
  turn.lastAccess = state.clocks.access
  const session = state.sessions.get(turn.sessionID)
  if (session !== undefined) session.lastAccess = state.clocks.access
}

export function markOverlapAmbiguous(state: TurnStoreState, successor: MutableTurn): void {
  const predecessor = [...(state.sessions.get(successor.sessionID)?.turns.values() ?? [])]
    .findLast((turn) => (
      turn.turnOrdinal < successor.turnOrdinal
      && turn.terminalState === "sealed"
      && turn.sealedBy === "next_turn"
      && turn.deferredFinalization
    ))
  if (predecessor === undefined) return
  predecessor.correlationStatus = "overlap_ambiguous"
  successor.correlationStatus = "overlap_ambiguous"
}

export function emitCounterDelta(state: TurnStoreState): void {
  state.clocks.counterSequence += 1
  const entry: IntentRoutingCounterDelta = {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: new Date(state.now()).toISOString(),
    processId: state.processId,
    counterEpoch: 0,
    monotonicSeq: state.clocks.counterSequence,
    counters: snapshotCounters(state.counters),
  }
  state.onEntry(entry)
}

export function settleTurn(turn: MutableTurn): void {
  const settle = turn.settle
  if (settle === undefined) return
  turn.settle = undefined
  settle()
}

function removePendingReference(state: TurnStoreState, turn: MutableTurn): void {
  const group = turn.pendingGroup
  turn.pendingGroup = undefined
  if (group === undefined) return
  group.records.delete(turn)
  if (group.records.size > 0 || !group.active) return
  group.active = false
  if (group.timer !== undefined) clearTimeout(group.timer)
  if (state.pendingByTierOne.get(group.tierOneKey) === group) {
    state.pendingByTierOne.delete(group.tierOneKey)
  }
}

export function removeTurn(state: TurnStoreState, turn: MutableTurn): void {
  removePendingReference(state, turn)
  state.sessions.get(turn.sessionID)?.turns.delete(turn.turnOrdinal)
}

export function tryFinalize(
  state: TurnStoreState,
  turn: MutableTurn,
  force = false,
): boolean {
  if (turn.finalized || turn.terminalState !== "sealed" || turn.predictionState === "pending") {
    return false
  }
  if (turn.deferredFinalization && !force) return false
  turn.deferredFinalization = false
  turn.finalized = true
  state.onEntry(buildObservationRecord(turn, state.now))
  removeTurn(state, turn)
  return true
}

export function applyTimeout(state: TurnStoreState, turn: MutableTurn, latencyMs: number): void {
  if (turn.predictionState !== "pending") return
  turn.predictionState = "timeout"
  turn.lifecycleState = "prediction_timeout"
  turn.unavailableReason = "timeout"
  turn.latencyMs = Math.max(0, latencyMs)
  turn.answers = EMPTY_INTENT_ROUTING_ANSWERS
  settleTurn(turn)
  tryFinalize(state, turn)
}

export function applyResult(
  state: TurnStoreState,
  turn: MutableTurn,
  result: IntentRoutingDecisionResult,
): void {
  if (turn.predictionState !== "pending") return
  turn.pendingGroup = undefined
  turn.truncatedInput = result.truncatedInput
  turn.unavailableReason = result.unavailableReason
  turn.resolvedModel = result.resolvedModel
  turn.latencyMs = result.latencyMs
  turn.answers = predictionAnswers(result)
  turn.invalidAnswerCount = result.invalidAnswerCount
  if (result.predictionStatus === "filled" && result.resolvedModel !== null) {
    turn.predictionState = "filled"
    turn.lifecycleState = "prediction_filled"
    turn.reuseKey = buildIntentRoutingTierTwoKey(turn.dedupKey, result.resolvedModel)
    cacheCompletedPrediction(state, turn)
  } else {
    turn.predictionState = "failed"
    turn.lifecycleState = "prediction_failed"
  }
  touchTurn(state, turn)
  settleTurn(turn)
  tryFinalize(state, turn)
}

export function reuseCompletedPrediction(
  turn: MutableTurn,
  predecessor: CompletedPrediction,
): void {
  turn.reuseKey = predecessor.reuseKey
  turn.predictionReused = true
  turn.predictionState = "filled"
  turn.lifecycleState = "prediction_filled"
  turn.unavailableReason = predecessor.unavailableReason
  turn.resolvedModel = predecessor.resolvedModel
  turn.latencyMs = predecessor.latencyMs
  turn.answers = predecessor.answers
  turn.invalidAnswerCount = predecessor.invalidAnswerCount
  turn.truncatedInput = predecessor.truncatedInput
  settleTurn(turn)
}
