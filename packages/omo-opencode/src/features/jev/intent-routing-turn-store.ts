import type { IntentRoutingObservedDelegation } from "@oh-my-opencode/jev-core"
import {
  buildEvictionDelta,
  buildObservationRecord,
  createTurnIdentity,
  normalizeIntentRoutingPrompt,
  snapshotTurn,
} from "./intent-routing-turn-record"
import { createIntentRoutingPredictionCache } from "./intent-routing-turn-prediction"
import type {
  CorrelationStatus,
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
  let monotonicSeq = 0

  function removeTurn(turn: LiveIntentRoutingTurn): void {
    sessions.get(turn.sessionID)?.turns.delete(turn.turnOrdinal)
    predictions.remove(turn)
  }

  function finalizeTurn(turn: LiveIntentRoutingTurn): void {
    if (turn.finalized) return
    options.sink(buildObservationRecord(turn, {
      schemaVersion,
      counterEpoch,
      recordedAt: now().toISOString(),
    }))
    turn.finalized = true
    removeTurn(turn)
  }

  const predictions = createIntentRoutingPredictionCache(finalizeTurn)

  function emitEviction(): void {
    monotonicSeq += 1
    options.sink(buildEvictionDelta({
      schemaVersion,
      recordedAt: now().toISOString(),
      processId: options.processId,
      counterEpoch,
      monotonicSeq,
      recordsCreated,
      recordsEvicted,
    }))
  }

  function evictTurn(turn: LiveIntentRoutingTurn): void {
    turn.state = "evicted"
    removeTurn(turn)
    recordsEvicted += 1
    emitEviction()
  }

  function forceFinalizeCensored(turn: LiveIntentRoutingTurn): void {
    if (turn.predictionStatus === "pending") {
      turn.predictionStatus = "timeout"
      predictions.remove(turn)
    }
    turn.correlationStatus = "censored"
    finalizeTurn(turn)
  }

  function enforceTurnCap(session: IntentRoutingSessionState, newest: LiveIntentRoutingTurn): void {
    while (session.turns.size > options.maxTurnsPerSession) {
      const turns = [...session.turns.values()]
      const victim = turns.find((turn) => turn !== newest && !(turn.state === "sealed" && !turn.finalized))
      if (victim !== undefined) {
        evictTurn(victim)
        continue
      }
      const deferred = turns.find((turn) => turn !== newest && turn.state === "sealed" && !turn.finalized)
      if (deferred !== undefined) {
        forceFinalizeCensored(deferred)
        continue
      }
      evictTurn(newest)
    }
  }

  function evictSession(sessionID: string): void {
    const session = sessions.get(sessionID)
    if (session === undefined) return
    for (const turn of [...session.turns.values()]) {
      if (turn.state === "sealed" && !turn.finalized) forceFinalizeCensored(turn)
      else evictTurn(turn)
    }
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
      const victimID = sessions.keys().next().value
      if (typeof victimID !== "string") break
      evictSession(victimID)
    }
    const created = { turns: new Map<number, LiveIntentRoutingTurn>(), nextOrdinal: ordinalHighWater + 1 }
    sessions.set(sessionID, created)
    return created
  }

  function finalizeSession(sessionID: string, sealedBy: "dispose" | "session_deleted"): void {
    const session = sessions.get(sessionID)
    if (session === undefined) return
    const turns = [...session.turns.values()]
    for (const turn of turns) {
      if (turn.predictionStatus === "pending") turn.predictionStatus = "timeout"
    }
    for (const turn of turns) predictions.remove(turn)
    for (const turn of turns) {
      turn.state = "sealed"
      turn.sealedBy = sealedBy
      turn.correlationStatus = sealedBy === "dispose" ? "censored" : (turn.correlationStatus ?? "reliable")
      finalizeTurn(turn)
    }
    sessions.delete(sessionID)
  }

  return {
    get evictedCount() { return recordsEvicted },
    get trackedSessionCount() { return sessions.size },
    get reuseEntryCount() { return predictions.size },
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
      const turn = session === undefined ? undefined : [...session.turns.values()].at(-1)
      if (session === undefined || turn === undefined || turn.finalized || turn.state === "evicted") return false
      turn.observed.push(observation)
      session.turns.delete(turn.turnOrdinal)
      session.turns.set(turn.turnOrdinal, turn)
      sessions.delete(sessionID)
      sessions.set(sessionID, session)
      return true
    },
    sealTurn(sessionID: string, turnOrdinal: number, sealedBy: SealedBy, correlationStatus?: CorrelationStatus): void {
      const turn = sessions.get(sessionID)?.turns.get(turnOrdinal)
      if (turn === undefined || turn.finalized || turn.state === "evicted") return
      turn.state = "sealed"
      turn.sealedBy = sealedBy
      turn.correlationStatus = correlationStatus ?? (sealedBy === "seal_timeout" || sealedBy === "dispose" ? "censored" : "reliable")
      if (turn.predictionStatus !== "pending" && sealedBy !== "next_turn") finalizeTurn(turn)
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
    },
  }
}
