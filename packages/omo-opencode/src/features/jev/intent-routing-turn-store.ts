import type {
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"
import { createMutableTurn } from "./intent-routing-turn-eviction"
import {
  buildIntentRoutingTierOneKey,
  buildIntentRoutingTierTwoKey,
  hashIntentRoutingPrompt,
  isPinnedIntentRoutingModelSpec,
  normalizeIntentRoutingPrompt,
} from "./intent-routing-turn-keys"
import {
  beginDispatch,
  coalescePending,
  completePendingGroup,
  reusableTurn,
} from "./intent-routing-turn-prediction"
import {
  createMutableCounters,
  defaultCorrelationStatus,
  positiveInteger,
  snapshotCounters,
  snapshotTurn,
} from "./intent-routing-turn-record"
import {
  emitCounterDelta,
  removeTurn,
  reuseCompletedPrediction,
  settleTurn,
  touchTurn,
  tryFinalize,
} from "./intent-routing-turn-runtime"
import {
  DEFAULT_INTENT_ROUTING_MAX_TRACKED_SESSIONS,
  DEFAULT_INTENT_ROUTING_MAX_TURNS_PER_SESSION,
  DEFAULT_INTENT_ROUTING_PREDICTION_TIMEOUT_MS,
  type IntentRoutingSealInput,
  type IntentRoutingStartTurnInput,
  type IntentRoutingTurnHandle,
  type IntentRoutingTurnSnapshot,
  type IntentRoutingTurnStore,
  type IntentRoutingTurnStoreInspection,
  type IntentRoutingTurnStoreOptions,
  type PendingGroup,
  type TurnStoreState,
} from "./intent-routing-turn-types"

export {
  buildIntentRoutingTierOneKey,
  buildIntentRoutingTierTwoKey,
  hashIntentRoutingPrompt,
  isPinnedIntentRoutingModelSpec,
  normalizeIntentRoutingPrompt,
} from "./intent-routing-turn-keys"
export {
  DEFAULT_INTENT_ROUTING_MAX_TRACKED_SESSIONS,
  DEFAULT_INTENT_ROUTING_MAX_TURNS_PER_SESSION,
  DEFAULT_INTENT_ROUTING_PREDICTION_TIMEOUT_MS,
} from "./intent-routing-turn-types"
export type {
  IntentRoutingLifecycleState,
  IntentRoutingPredictionState,
  IntentRoutingPromptPart,
  IntentRoutingSealInput,
  IntentRoutingStartTurnInput,
  IntentRoutingTerminalState,
  IntentRoutingTurnHandle,
  IntentRoutingTurnSnapshot,
  IntentRoutingTurnStore,
  IntentRoutingTurnStoreInspection,
  IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-types"

function createState(options: IntentRoutingTurnStoreOptions): TurnStoreState {
  return {
    maxTrackedSessions: positiveInteger(
      options.maxTrackedSessions,
      DEFAULT_INTENT_ROUTING_MAX_TRACKED_SESSIONS,
    ),
    maxTurnsPerSession: positiveInteger(
      options.maxTurnsPerSession,
      DEFAULT_INTENT_ROUTING_MAX_TURNS_PER_SESSION,
    ),
    predictionTimeoutMs: positiveInteger(
      options.predictionTimeoutMs,
      DEFAULT_INTENT_ROUTING_PREDICTION_TIMEOUT_MS,
    ),
    processId: options.processId ?? `turn-store-${process.pid}-${Date.now()}`,
    now: options.now ?? Date.now,
    onEntry: options.onEntry ?? (() => undefined),
    sessions: new Map(),
    pendingByTierOne: new Map(),
    completedByTierTwo: new Map(),
    counters: createMutableCounters(),
    clocks: { ordinalHighWater: 0, access: 0, counterSequence: 0 },
  }
}

export function createIntentRoutingTurnStore(
  options: IntentRoutingTurnStoreOptions = {},
): IntentRoutingTurnStore {
  const state = createState(options)
  let disposed = false

  function startTurn(input: IntentRoutingStartTurnInput): IntentRoutingTurnHandle | null {
    if (disposed) return null
    const sessionID = typeof input.sessionID === "string" ? input.sessionID.trim() : ""
    if (sessionID === "") return null
    state.counters.turnsSeen += 1
    const normalizedPrompt = normalizeIntentRoutingPrompt(input.parts)
    const promptHash = hashIntentRoutingPrompt(normalizedPrompt)
    const dedupKey = buildIntentRoutingTierOneKey({
      sessionID,
      promptHash,
      questionVersion: input.questionVersion,
      vocabularyDigest: input.vocabularyDigest,
      confidenceThreshold: input.confidenceThreshold,
      configuredModelSpec: input.configuredModelSpec,
    })
    const turn = createMutableTurn({ state, input, sessionID, normalizedPrompt, promptHash, dedupKey })
    const handle = { sessionID, turnOrdinal: turn.turnOrdinal, dedupKey, promptHash, settled: turn.settled }
    const pending = state.pendingByTierOne.get(dedupKey)
    if (pending !== undefined && pending.active) {
      coalescePending(turn, pending)
      return handle
    }
    const knownResolvedModel = isPinnedIntentRoutingModelSpec(input.configuredModelSpec)
      ? input.configuredModelSpec
      : input.knownResolvedModel
    if (knownResolvedModel !== undefined) {
      const predecessor = reusableTurn(
        state,
        buildIntentRoutingTierTwoKey(dedupKey, knownResolvedModel),
      )
      if (predecessor !== undefined) {
        reuseCompletedPrediction(state, turn, predecessor)
        return handle
      }
    }
    if (input.dispatch === undefined) {
      turn.predictionState = "not_dispatched"
      turn.lifecycleState = "not_dispatched"
      turn.notDispatchedReason = input.notDispatchedReason ?? "dispatcher_unavailable"
      settleTurn(turn)
      return handle
    }
    beginDispatch(state, turn, input.dispatch)
    return handle
  }

  function appendObservation(
    sessionID: string,
    turnOrdinal: number,
    observation: IntentRoutingObservedDelegation,
  ): boolean {
    const turn = state.sessions.get(sessionID)?.turns.get(turnOrdinal)
    if (turn === undefined || turn.terminalState !== "live") {
      state.counters.orphanObservations += 1
      emitCounterDelta(state)
      return false
    }
    turn.observed.push(observation)
    if (observation.routeClass === "unscorable_resume") state.counters.unscorableResumeCalls += 1
    if (observation.routeClass === "unknown") state.counters.unscorableUnknownCalls += 1
    touchTurn(state, turn)
    return true
  }

  function sealTurn(input: IntentRoutingSealInput): boolean {
    const turn = state.sessions.get(input.sessionID)?.turns.get(input.turnOrdinal)
    if (turn === undefined || turn.terminalState !== "live") return false
    turn.terminalState = "sealed"
    turn.lifecycleState = "sealed"
    turn.sealedBy = input.sealedBy
    turn.correlationStatus = input.correlationStatus ?? defaultCorrelationStatus(input.sealedBy)
    turn.deferredFinalization = input.deferFinalization === true
    touchTurn(state, turn)
    tryFinalize(state, turn)
    return true
  }

  function finalizeTurn(
    sessionID: string,
    turnOrdinal: number,
    correlationStatus?: IntentRoutingObservationRecord["correlationStatus"],
  ): boolean {
    const turn = state.sessions.get(sessionID)?.turns.get(turnOrdinal)
    if (turn === undefined || turn.terminalState !== "sealed") return false
    if (correlationStatus !== undefined) turn.correlationStatus = correlationStatus
    turn.deferredFinalization = false
    return tryFinalize(state, turn)
  }

  function terminateSession(sessionID: string, sealedBy: "session_deleted" | "dispose"): void {
    const session = state.sessions.get(sessionID)
    if (session === undefined) return
    const groups = new Set<PendingGroup>()
    for (const turn of session.turns.values()) {
      if (turn.pendingGroup !== undefined) groups.add(turn.pendingGroup)
    }
    for (const group of groups) completePendingGroup(state, group, undefined)
    for (const turn of [...session.turns.values()]) {
      if (turn.terminalState === "live") {
        sealTurn({ sessionID, turnOrdinal: turn.turnOrdinal, sealedBy })
      } else if (turn.terminalState === "sealed") {
        if (sealedBy === "dispose") turn.correlationStatus = "censored"
        turn.deferredFinalization = false
        tryFinalize(state, turn)
      }
    }
    for (const turn of [...session.turns.values()]) removeTurn(state, turn)
    state.sessions.delete(sessionID)
  }

  function getSessionTurns(sessionID: string): readonly IntentRoutingTurnSnapshot[] {
    const session = state.sessions.get(sessionID)
    if (session === undefined) return []
    return [...session.turns.values()]
      .sort((left, right) => left.turnOrdinal - right.turnOrdinal)
      .map(snapshotTurn)
  }

  return {
    startTurn,
    appendObservation,
    sealTurn,
    finalizeTurn,
    deleteSession: (sessionID) => terminateSession(sessionID, "session_deleted"),
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const sessionID of [...state.sessions.keys()]) terminateSession(sessionID, "dispose")
      state.pendingByTierOne.clear()
      state.completedByTierTwo.clear()
    },
    getTurn: (sessionID, turnOrdinal) => {
      const turn = state.sessions.get(sessionID)?.turns.get(turnOrdinal)
      return turn === undefined ? undefined : snapshotTurn(turn)
    },
    getSessionTurns,
    getCounters: () => snapshotCounters(state.counters),
    inspect: (): IntentRoutingTurnStoreInspection => ({
      sessionCount: state.sessions.size,
      pendingCoalescingCount: state.pendingByTierOne.size,
      completedCacheCount: state.completedByTierTwo.size,
      evictedCount: state.counters.recordsEvicted,
    }),
  }
}
