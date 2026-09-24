// allow: SIZE_OK - one state machine owns the turn lifecycle and its transition invariants.
import type { IntentRoutingObservedDelegation } from "@oh-my-opencode/jev-core"
import {
  buildObservationRecord,
  buildStoreCounterDelta,
  createTurnIdentity,
  normalizeIntentRoutingPrompt,
  snapshotTurn,
} from "./intent-routing-turn-record"
import { createIntentRoutingPredictionCache } from "./intent-routing-turn-prediction"
import type {
  IntentRoutingSessionState,
  IntentRoutingTurnInput,
  IntentRoutingTurnSnapshot,
  IntentRoutingTurnStoreOptions,
  LiveIntentRoutingTurn,
  SealedBy,
} from "./intent-routing-turn-store-types"

export { normalizeIntentRoutingPrompt }
export type {
  IntentRoutingTurnInput,
  IntentRoutingTurnSnapshot,
  IntentRoutingTurnState,
  IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-store-types"

export function createIntentRoutingTurnStore(options: IntentRoutingTurnStoreOptions) {
  if (options.maxTrackedSessions < 1 || options.maxTurnsPerSession < 1) {
    throw new RangeError("Intent-routing turn-store bounds must be positive")
  }
  const sessions = new Map<string, IntentRoutingSessionState>()
  const schemaVersion = options.schemaVersion ?? 1
  const counterEpoch = options.counterEpoch ?? 0
  const now = options.now ?? (() => new Date())
  let ordinalHighWater = 0
  let recordsCreated = 0
  let recordsEvicted = 0
  let orphanObservations = 0
  let monotonicSeq = 0
  const sourceCounters = options.sourceCounters ?? (() => ({
    turnsSeen: 0,
    turnsGatedOut: 0,
    turnsSynthetic: 0,
    unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0,
    dispatchesDropped: 0,
  }))

  function recordsInFlight(): number {
    let total = 0
    for (const session of sessions.values()) total += session.turns.size
    return total
  }

  function removeTurn(turn: LiveIntentRoutingTurn): void {
    const session = sessions.get(turn.sessionID)
    session?.turns.delete(turn.turnOrdinal)
    predictions.remove(turn)
    if (session?.turns.size === 0) sessions.delete(turn.sessionID)
  }

  function finalizeTurn(turn: LiveIntentRoutingTurn): void {
    if (turn.finalized || !turn.correlationWindowClosed || turn.predictionStatus === "pending") return
    const record = buildObservationRecord(turn, {
      schemaVersion,
      counterEpoch,
      recordedAt: now().toISOString(),
    })
    turn.finalized = true
    removeTurn(turn)
    options.sink(record)
  }

  const predictions = createIntentRoutingPredictionCache(finalizeTurn)

  function emitCounters(): void {
    monotonicSeq += 1
    const source = sourceCounters()
    options.sink(buildStoreCounterDelta({
      schemaVersion,
      recordedAt: now().toISOString(),
      processId: options.processId,
      counterEpoch,
      monotonicSeq,
      recordsCreated,
      recordsInFlight: recordsInFlight(),
      recordsEvicted,
      orphanObservations,
      ...source,
    }))
  }

  function evictTurn(turn: LiveIntentRoutingTurn): void {
    turn.state = "evicted"
    removeTurn(turn)
    recordsEvicted += 1
    emitCounters()
  }

  function isDeferred(turn: LiveIntentRoutingTurn): boolean {
    return turn.state === "sealed" && !turn.correlationWindowClosed && !turn.finalized
  }

  function enforceTurnCap(session: IntentRoutingSessionState, newest: LiveIntentRoutingTurn): void {
    while (session.turns.size > options.maxTurnsPerSession) {
      const victim = [...session.turns.values()].find((turn) => turn !== newest && !isDeferred(turn))
      if (victim === undefined) break
      evictTurn(victim)
    }
  }

  function evictSession(sessionID: string): void {
    const session = sessions.get(sessionID)
    if (session === undefined) return
    for (const turn of [...session.turns.values()]) evictTurn(turn)
    sessions.delete(sessionID)
  }

  function getSession(sessionID: string): IntentRoutingSessionState {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) {
      sessions.delete(sessionID)
      sessions.set(sessionID, existing)
      return existing
    }
    while (sessions.size >= options.maxTrackedSessions) {
      const victim = [...sessions.entries()].find(([, session]) => ![...session.turns.values()].some(isDeferred))
      if (victim === undefined) break
      evictSession(victim[0])
    }
    const created = { turns: new Map<number, LiveIntentRoutingTurn>(), nextOrdinal: ordinalHighWater + 1 }
    sessions.set(sessionID, created)
    return created
  }

  function latestTurn(session: IntentRoutingSessionState): LiveIntentRoutingTurn | undefined {
    return [...session.turns.values()].sort((left, right) => left.turnOrdinal - right.turnOrdinal).at(-1)
  }

  function closeDeferredPredecessor(session: IntentRoutingSessionState, successorOrdinal: number): void {
    const predecessor = [...session.turns.values()]
      .filter((turn) => turn.turnOrdinal < successorOrdinal && isDeferred(turn))
      .sort((left, right) => right.turnOrdinal - left.turnOrdinal)[0]
    if (predecessor === undefined) return
    predecessor.correlationWindowClosed = true
    finalizeTurn(predecessor)
  }

  function sealTurn(turn: LiveIntentRoutingTurn, sealedBy: SealedBy): void {
    if (turn.finalized || turn.state === "evicted" || turn.state === "sealed") return
    const session = sessions.get(turn.sessionID)
    if (session === undefined) return
    closeDeferredPredecessor(session, turn.turnOrdinal)
    turn.state = "sealed"
    turn.sealedBy = sealedBy
    turn.correlationStatus = sealedBy === "seal_timeout" || sealedBy === "dispose"
      ? "censored"
      : (turn.correlationStatus ?? "reliable")
    turn.correlationWindowClosed = sealedBy !== "next_turn"
    finalizeTurn(turn)
  }

  function closeSessionCorrelation(sessionID: string): void {
    const session = sessions.get(sessionID)
    if (session === undefined) return
    for (const turn of [...session.turns.values()]) {
      turn.correlationWindowClosed = true
      finalizeTurn(turn)
    }
  }

  function finalizeSession(sessionID: string, sealedBy: "dispose" | "session_deleted"): void {
    const session = sessions.get(sessionID)
    if (session === undefined) return
    const turns = [...session.turns.values()]
    for (const turn of turns) {
      if (turn.predictionStatus === "pending") turn.predictionStatus = "timeout"
      predictions.remove(turn)
      if (turn.state !== "sealed") sealTurn(turn, sealedBy)
    }
    closeSessionCorrelation(sessionID)
    sessions.delete(sessionID)
  }

  return {
    get evictedCount() { return recordsEvicted },
    get trackedSessionCount() { return sessions.size },
    get reuseEntryCount() { return predictions.size },
    emitCounters,
    createTurn(input: IntentRoutingTurnInput): IntentRoutingTurnSnapshot {
      const session = getSession(input.sessionID)
      const turnOrdinal = session.nextOrdinal
      session.nextOrdinal += 1
      ordinalHighWater = Math.max(ordinalHighWater, turnOrdinal)
      const identity = createTurnIdentity(input)
      const turn: LiveIntentRoutingTurn = {
        state: "created",
        sessionID: input.sessionID,
        turnOrdinal,
        ...identity,
        reuseKey: identity.dedupKey,
        questionVersion: input.questionVersion,
        truncatedInput: input.truncatedInput,
        predictionStatus: "pending",
        predictionReused: false,
        notDispatchedReason: null,
        unavailableReason: null,
        resolvedModel: null,
        latencyMs: 0,
        answers: null,
        invalidAnswerCount: 0,
        observed: [],
        sealedBy: null,
        correlationStatus: null,
        correlationWindowClosed: false,
        finalized: false,
      }
      session.turns.set(turnOrdinal, turn)
      recordsCreated += 1
      predictions.dispatch(turn, input)
      enforceTurnCap(session, turn)
      return snapshotTurn(turn)
    },
    appendObservation(sessionID: string, observation: IntentRoutingObservedDelegation): boolean {
      const session = sessions.get(sessionID)
      const turn = session === undefined ? undefined : latestTurn(session)
      if (session === undefined || turn === undefined || turn.finalized || turn.state === "sealed" || turn.state === "evicted") {
        orphanObservations += 1
        emitCounters()
        return false
      }
      const predecessor = [...session.turns.values()].find((candidate) =>
        candidate.turnOrdinal < turn.turnOrdinal && isDeferred(candidate),
      )
      if (predecessor !== undefined) {
        predecessor.correlationStatus = "overlap_ambiguous"
        turn.correlationStatus = "overlap_ambiguous"
      }
      turn.observed.push(observation)
      sessions.delete(sessionID)
      sessions.set(sessionID, session)
      return true
    },
    sealTurn(sessionID: string, turnOrdinal: number, sealedBy: SealedBy): void {
      const turn = sessions.get(sessionID)?.turns.get(turnOrdinal)
      if (turn !== undefined) sealTurn(turn, sealedBy)
    },
    sealSessionIdle(sessionID: string): void {
      const session = sessions.get(sessionID)
      if (session === undefined) return
      const turn = latestTurn(session)
      if (turn !== undefined && turn.state !== "sealed") sealTurn(turn, "session_idle")
      closeSessionCorrelation(sessionID)
    },
    getTurn(sessionID: string, turnOrdinal: number): IntentRoutingTurnSnapshot | undefined {
      const turn = sessions.get(sessionID)?.turns.get(turnOrdinal)
      return turn === undefined ? undefined : snapshotTurn(turn)
    },
    listTurns(sessionID: string): readonly IntentRoutingTurnSnapshot[] {
      return [...(sessions.get(sessionID)?.turns.values() ?? [])]
        .sort((left, right) => left.turnOrdinal - right.turnOrdinal)
        .map(snapshotTurn)
    },
    deleteSession(sessionID: string): void { finalizeSession(sessionID, "session_deleted") },
    dispose(): void {
      for (const sessionID of [...sessions.keys()]) finalizeSession(sessionID, "dispose")
      predictions.clear()
      emitCounters()
    },
  }
}

export type IntentRoutingTurnStore = ReturnType<typeof createIntentRoutingTurnStore>
