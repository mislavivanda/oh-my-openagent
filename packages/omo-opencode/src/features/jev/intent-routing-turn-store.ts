// allow: SIZE_OK - The turn, pending-reuse, LRU, and cleanup transitions share one reservation identity and must remain atomic.

import { createHash } from "node:crypto"

import {
  INTENT_ROUTING_SCHEMA_VERSION,
  isIntentRoutingContinuationCandidate,
  type IntentRoutingCorrelationStatus,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingDecisionAnswers,
  type IntentRoutingDecisionResult,
  type IntentRoutingObservedDelegation,
  type IntentRoutingPredictionStatus,
  type IntentRoutingSealedBy,
} from "@oh-my-opencode/jev-core"

import { removeSystemReminders } from "../../shared"

export const DEFAULT_MAX_TRACKED_INTENT_ROUTING_SESSIONS = 256
export const DEFAULT_MAX_INTENT_ROUTING_TURNS_PER_SESSION = 128

export type IntentRoutingTurnState = "created" | "prediction_filled" | "prediction_failed" |
  "prediction_timeout" | "not_dispatched" | "sealed" | "evicted"

export type IntentRoutingTurnRecord = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly preDispatchKey: string
  readonly reuseKey: string
  readonly predictionReused: boolean
  readonly state: IntentRoutingTurnState
  readonly predictionStatus: IntentRoutingPredictionStatus | "pending"
  readonly notDispatchedReason: string | null
  readonly answers: IntentRoutingDecisionAnswers | null
  readonly invalidAnswerCount: number
  readonly unavailableReason: IntentRoutingDecisionResult["unavailableReason"]
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly sealedBy: IntentRoutingSealedBy | null
  readonly correlationStatus: IntentRoutingCorrelationStatus | null
  readonly awaitingFinalization: boolean
}

type IntentRoutingTurnIdentity = {
  readonly sessionID: string
  readonly textParts: readonly string[]
  readonly questionVersion: number
  readonly vocabularyDigest: string
  readonly confidenceThreshold: number
  readonly configuredModelSpec: string
  readonly knownResolvedModel?: string
}

export type IntentRoutingDispatchedTurnInput = IntentRoutingTurnIdentity & {
  readonly dispatch: () => Promise<IntentRoutingDecisionResult>
  readonly notDispatchedReason?: never
}
export type IntentRoutingNotDispatchedTurnInput = IntentRoutingTurnIdentity & {
  readonly dispatch?: never
  readonly notDispatchedReason: string
}
export type IntentRoutingTurnInput = IntentRoutingDispatchedTurnInput | IntentRoutingNotDispatchedTurnInput
export type IntentRoutingTimeoutHandle = { readonly cancel: () => void }
export type IntentRoutingScheduleTimeout = (callback: () => void, delayMs: number) => IntentRoutingTimeoutHandle
export type IntentRoutingSealInput = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly sealedBy: IntentRoutingSealedBy
  readonly deferFinalization?: boolean
}

export type IntentRoutingTurnStoreOptions = {
  readonly maxTrackedSessions?: number
  readonly maxTurnsPerSession?: number
  readonly predictionTimeoutMs?: number
  readonly processId?: string
  readonly counterEpoch?: number
  readonly now?: () => number
  readonly scheduleTimeout?: IntentRoutingScheduleTimeout
  readonly onCounterDelta?: (entry: IntentRoutingCounterDelta) => void
  readonly onFinalize?: (record: IntentRoutingTurnRecord) => void
}

export type IntentRoutingTurnStore = {
  readonly createTurn: (input: IntentRoutingTurnInput) => IntentRoutingTurnRecord
  readonly appendObservation: (input: { readonly sessionID: string; readonly observation: IntentRoutingObservedDelegation }) => boolean
  readonly getTurn: (sessionID: string, turnOrdinal: number) => IntentRoutingTurnRecord | undefined
  readonly listTurns: (sessionID: string) => readonly IntentRoutingTurnRecord[]
  readonly sealTurn: (input: IntentRoutingSealInput) => boolean
  readonly finalizeTurn: (input: { readonly sessionID: string; readonly turnOrdinal: number }) => boolean
  readonly deleteSession: (sessionID: string) => void
  readonly getCounters: () => IntentRoutingCounters
  readonly getMapSizes: () => { readonly sessions: number; readonly reuseSessions: number }
  readonly dispose: () => void
}

type MutableTurn = {
  sessionID: string; turnOrdinal: number; dedupKey: string; preDispatchKey: string; reuseKey: string
  predictionReused: boolean; state: IntentRoutingTurnState; predictionStatus: IntentRoutingPredictionStatus | "pending"
  notDispatchedReason: string | null; answers: IntentRoutingDecisionAnswers | null
  invalidAnswerCount: number; unavailableReason: IntentRoutingDecisionResult["unavailableReason"]
  resolvedModel: string | null; latencyMs: number | null; observed: IntentRoutingObservedDelegation[]
  sealedBy: IntentRoutingSealedBy | null; correlationStatus: IntentRoutingCorrelationStatus | null
  awaitingFinalization: boolean; deferFinalization: boolean; finalized: boolean; access: number
  questionVersion: number; confidenceThreshold: number; configuredModelSpec: string
}
type SessionTurns = { nextOrdinal: number; access: number; readonly turns: Map<number, MutableTurn> }
type PendingPrediction = {
  readonly sessionID: string; readonly preDispatchKey: string; readonly waiters: Set<number>
  timeout: IntentRoutingTimeoutHandle | null
}
type CompletedPrediction = { readonly turnOrdinal: number; readonly result: IntentRoutingDecisionResult }
type ReuseState = {
  readonly pending: Map<string, PendingPrediction>
  readonly completed: Map<string, CompletedPrediction>
}
type MutableCounters = { -readonly [Key in keyof IntentRoutingCounters]: number }

const EMPTY_COUNTERS: IntentRoutingCounters = {
  turnsSeen: 0, turnsGatedOut: 0, turnsSynthetic: 0, recordsCreated: 0, recordsEvicted: 0,
  orphanObservations: 0, unscorableResumeCalls: 0, unscorableUnknownCalls: 0,
  dispatchesDropped: 0, malformedWriteRejections: 0, recordsLostToCap: 0, sinkTruncations: 0,
}

export function normalizeIntentRoutingPrompt(textParts: readonly string[]): string {
  return removeSystemReminders(textParts.join("")).trim().replace(/\s+/gu, " ").toLowerCase()
}

export function createIntentRoutingPromptHash(textParts: readonly string[]): string {
  return createHash("sha256").update(normalizeIntentRoutingPrompt(textParts), "utf8").digest("hex")
}

export function createIntentRoutingPreDispatchKey(input: {
  readonly sessionID: string; readonly promptHash: string; readonly questionVersion: number
  readonly vocabularyDigest: string; readonly confidenceThreshold: number; readonly configuredModelSpec: string
}): string {
  return JSON.stringify([
    input.sessionID, input.promptHash, input.questionVersion, input.vocabularyDigest,
    input.confidenceThreshold, input.configuredModelSpec,
  ])
}

export function createIntentRoutingCompletedCacheKey(preDispatchKey: string, resolvedModel: string): string {
  return JSON.stringify([preDispatchKey, resolvedModel])
}

export function isPinnedIntentRoutingModelSpec(model: string): boolean {
  return /(?:^|\/)jev-\d{4}-\d{2}-\d{2}$/u.test(model)
}

function defaultScheduleTimeout(callback: () => void, delayMs: number): IntentRoutingTimeoutHandle {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return { cancel: () => clearTimeout(timer) }
}

function snapshot(turn: MutableTurn): IntentRoutingTurnRecord {
  return {
    sessionID: turn.sessionID, turnOrdinal: turn.turnOrdinal, dedupKey: turn.dedupKey,
    preDispatchKey: turn.preDispatchKey, reuseKey: turn.reuseKey, predictionReused: turn.predictionReused,
    state: turn.state, predictionStatus: turn.predictionStatus, notDispatchedReason: turn.notDispatchedReason,
    answers: turn.answers === null ? null : structuredClone(turn.answers), invalidAnswerCount: turn.invalidAnswerCount,
    unavailableReason: turn.unavailableReason, resolvedModel: turn.resolvedModel, latencyMs: turn.latencyMs,
    observed: turn.observed.map((entry) => structuredClone(entry)), sealedBy: turn.sealedBy,
    correlationStatus: turn.correlationStatus, awaitingFinalization: turn.awaitingFinalization,
  }
}

function failedPrediction(turn: MutableTurn, reason: "timeout" | "transport_error"): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed", truncatedInput: false, answers: null, invalidAnswerCount: 0,
    unavailableReason: reason, resolvedModel: null, latencyMs: null,
    threshold: turn.confidenceThreshold, questionVersion: turn.questionVersion,
  }
}

export function createIntentRoutingTurnStore(options: IntentRoutingTurnStoreOptions = {}): IntentRoutingTurnStore {
  const sessions = new Map<string, SessionTurns>()
  const reuseBySession = new Map<string, ReuseState>()
  const counters: MutableCounters = { ...EMPTY_COUNTERS }
  const maxSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_INTENT_ROUTING_SESSIONS
  const maxTurns = options.maxTurnsPerSession ?? DEFAULT_MAX_INTENT_ROUTING_TURNS_PER_SESSION
  const predictionTimeoutMs = options.predictionTimeoutMs ?? 2500
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout
  const now = options.now ?? Date.now
  const counterEpoch = options.counterEpoch ?? now()
  const processId = options.processId ?? `${process.pid}-turn-store`
  let access = 0
  let monotonicSeq = 0

  const touch = (turn: MutableTurn, session: SessionTurns): void => {
    access += 1
    turn.access = access
    session.access = access
  }
  const finalize = (turn: MutableTurn): boolean => {
    if (turn.finalized || turn.predictionStatus === "pending" || turn.state !== "sealed") return false
    turn.awaitingFinalization = false
    turn.finalized = true
    options.onFinalize?.(snapshot(turn))
    return true
  }
  const emitEviction = (): void => {
    counters.recordsEvicted += 1
    counters.recordsLostToCap += 1
    monotonicSeq += 1
    options.onCounterDelta?.({
      kind: "counter_delta", schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
      recordedAt: new Date(now()).toISOString(), processId, counterEpoch, monotonicSeq,
      counters: { ...counters },
    })
  }
  const getReuse = (sessionID: string): ReuseState => {
    const existing = reuseBySession.get(sessionID)
    if (existing) return existing
    const created = { pending: new Map<string, PendingPrediction>(), completed: new Map<string, CompletedPrediction>() }
    reuseBySession.set(sessionID, created)
    return created
  }
  const removeTurnReuse = (turn: MutableTurn): void => {
    const reuse = reuseBySession.get(turn.sessionID)
    if (!reuse) return
    for (const [key, completed] of reuse.completed) {
      if (completed.turnOrdinal === turn.turnOrdinal) reuse.completed.delete(key)
    }
    for (const [key, pending] of reuse.pending) {
      pending.waiters.delete(turn.turnOrdinal)
      if (pending.waiters.size === 0) {
        pending.timeout?.cancel()
        reuse.pending.delete(key)
      }
    }
  }
  const evictTurn = (session: SessionTurns, turn: MutableTurn): void => {
    if (turn.awaitingFinalization) {
      turn.correlationStatus = "censored"
      turn.deferFinalization = false
      finalize(turn)
    }
    turn.state = "evicted"
    removeTurnReuse(turn)
    session.turns.delete(turn.turnOrdinal)
    emitEviction()
  }
  const oldestTurn = (session: SessionTurns): MutableTurn | undefined => {
    let oldest: MutableTurn | undefined
    for (const turn of session.turns.values()) {
      if (turn.awaitingFinalization) continue
      if (!oldest || turn.access < oldest.access) oldest = turn
    }
    if (oldest) return oldest
    for (const turn of session.turns.values()) {
      if (!oldest || turn.access < oldest.access) oldest = turn
    }
    return oldest
  }
  const trimTurns = (session: SessionTurns): void => {
    while (session.turns.size > maxTurns) {
      const victim = oldestTurn(session)
      if (!victim) return
      evictTurn(session, victim)
    }
  }
  const evictOldestSession = (): void => {
    let victimID: string | undefined
    let oldestAccess = Number.POSITIVE_INFINITY
    for (const [sessionID, session] of sessions) {
      if (session.access < oldestAccess) { victimID = sessionID; oldestAccess = session.access }
    }
    if (!victimID) return
    const victim = sessions.get(victimID)
    if (victim) for (const turn of [...victim.turns.values()]) evictTurn(victim, turn)
    sessions.delete(victimID)
    reuseBySession.delete(victimID)
  }
  const getSession = (sessionID: string): SessionTurns => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    while (sessions.size >= maxSessions) evictOldestSession()
    const created = { nextOrdinal: 1, access: ++access, turns: new Map<number, MutableTurn>() }
    sessions.set(sessionID, created)
    return created
  }
  const applyPrediction = (turn: MutableTurn, result: IntentRoutingDecisionResult): void => {
    if (turn.state === "evicted" || turn.predictionStatus !== "pending") return
    const timedOut = result.predictionStatus === "failed" && result.unavailableReason === "timeout"
    turn.predictionStatus = timedOut ? "timeout" : result.predictionStatus
    if (turn.state !== "sealed") {
      turn.state = result.predictionStatus === "filled" ? "prediction_filled" :
        timedOut ? "prediction_timeout" : "prediction_failed"
    }
    turn.answers = result.answers === null ? null : structuredClone(result.answers)
    turn.invalidAnswerCount = result.invalidAnswerCount
    turn.unavailableReason = result.unavailableReason
    turn.resolvedModel = result.resolvedModel
    turn.latencyMs = result.latencyMs
    if (result.predictionStatus === "filled" && result.resolvedModel) {
      turn.reuseKey = createIntentRoutingCompletedCacheKey(turn.preDispatchKey, result.resolvedModel)
      getReuse(turn.sessionID).completed.set(turn.reuseKey, { turnOrdinal: turn.turnOrdinal, result: structuredClone(result) })
    }
    if (turn.state === "sealed" && !turn.deferFinalization) finalize(turn)
  }
  const completePending = (pending: PendingPrediction, result: IntentRoutingDecisionResult): void => {
    const reuse = reuseBySession.get(pending.sessionID)
    if (!reuse || reuse.pending.get(pending.preDispatchKey) !== pending) return
    pending.timeout?.cancel()
    reuse.pending.delete(pending.preDispatchKey)
    const session = sessions.get(pending.sessionID)
    if (!session) return
    for (const ordinal of pending.waiters) {
      const turn = session.turns.get(ordinal)
      if (turn) applyPrediction(turn, structuredClone(result))
    }
  }
  const timeoutPending = (pending: PendingPrediction): void => {
    const session = sessions.get(pending.sessionID)
    const firstOrdinal = pending.waiters.values().next().value
    const first = typeof firstOrdinal === "number" ? session?.turns.get(firstOrdinal) : undefined
    if (first) completePending(pending, failedPrediction(first, "timeout"))
  }
  const clearSession = (sessionID: string, sealedBy: "session_deleted" | "dispose"): void => {
    const session = sessions.get(sessionID)
    if (!session) return
    const reuse = reuseBySession.get(sessionID)
    if (reuse) for (const pending of reuse.pending.values()) pending.timeout?.cancel()
    for (const turn of session.turns.values()) {
      if (turn.predictionStatus === "pending") applyPrediction(turn, failedPrediction(turn, "timeout"))
      turn.state = "sealed"
      turn.sealedBy = sealedBy
      turn.correlationStatus = sealedBy === "dispose" ? "censored" : (turn.correlationStatus ?? "reliable")
      turn.deferFinalization = false
      finalize(turn)
    }
    sessions.delete(sessionID)
    reuseBySession.delete(sessionID)
  }

  const createTurn = (input: IntentRoutingTurnInput): IntentRoutingTurnRecord => {
    const session = getSession(input.sessionID)
    const promptHash = createIntentRoutingPromptHash(input.textParts)
    const preDispatchKey = createIntentRoutingPreDispatchKey({ ...input, promptHash })
    const turn: MutableTurn = {
      sessionID: input.sessionID, turnOrdinal: session.nextOrdinal++, dedupKey: promptHash,
      preDispatchKey, reuseKey: preDispatchKey, predictionReused: false, state: "created",
      predictionStatus: "pending", notDispatchedReason: null, answers: null, invalidAnswerCount: 0,
      unavailableReason: null, resolvedModel: null, latencyMs: null, observed: [], sealedBy: null,
      correlationStatus: null, awaitingFinalization: false, deferFinalization: false, finalized: false,
      access: 0, questionVersion: input.questionVersion, confidenceThreshold: input.confidenceThreshold,
      configuredModelSpec: input.configuredModelSpec,
    }
    touch(turn, session)
    session.turns.set(turn.turnOrdinal, turn)
    counters.turnsSeen += 1
    counters.recordsCreated += 1
    trimTurns(session)
    if (!input.dispatch) {
      turn.state = "not_dispatched"
      turn.predictionStatus = "not_dispatched"
      turn.notDispatchedReason = input.notDispatchedReason
      counters.turnsGatedOut += 1
      return snapshot(turn)
    }

    const reuse = getReuse(input.sessionID)
    const pending = reuse.pending.get(preDispatchKey)
    if (pending) {
      turn.predictionReused = true
      pending.waiters.add(turn.turnOrdinal)
      return snapshot(turn)
    }
    const candidateModel = input.knownResolvedModel ??
      (isPinnedIntentRoutingModelSpec(input.configuredModelSpec) ? input.configuredModelSpec : undefined)
    const completedKey = candidateModel ? createIntentRoutingCompletedCacheKey(preDispatchKey, candidateModel) : undefined
    const completed = completedKey ? reuse.completed.get(completedKey) : undefined
    if (completed) {
      turn.predictionReused = true
      applyPrediction(turn, structuredClone(completed.result))
      return snapshot(turn)
    }

    const reservation: PendingPrediction = {
      sessionID: input.sessionID, preDispatchKey, waiters: new Set([turn.turnOrdinal]), timeout: null,
    }
    reuse.pending.set(preDispatchKey, reservation)
    reservation.timeout = scheduleTimeout(() => timeoutPending(reservation), predictionTimeoutMs)
    input.dispatch().then(
      (result) => completePending(reservation, result),
      () => completePending(reservation, failedPrediction(turn, "transport_error")),
    )
    return snapshot(turn)
  }

  return {
    createTurn,
    appendObservation: ({ sessionID, observation }) => {
      const session = sessions.get(sessionID)
      const turn = session ? [...session.turns.values()].toReversed().find((candidate) => candidate.state !== "sealed") : undefined
      if (!session || !turn) { counters.orphanObservations += 1; return false }
      turn.observed.push(structuredClone(observation))
      touch(turn, session)
      return true
    },
    getTurn: (sessionID, ordinal) => {
      const session = sessions.get(sessionID)
      const turn = session?.turns.get(ordinal)
      if (!session || !turn) return undefined
      touch(turn, session)
      return snapshot(turn)
    },
    listTurns: (sessionID) => [...(sessions.get(sessionID)?.turns.values() ?? [])]
      .sort((left, right) => left.turnOrdinal - right.turnOrdinal).map(snapshot),
    sealTurn: (input) => {
      const turn = sessions.get(input.sessionID)?.turns.get(input.turnOrdinal)
      if (!turn || turn.state === "evicted" || turn.state === "sealed") return false
      turn.state = "sealed"
      turn.sealedBy = input.sealedBy
      turn.correlationStatus = input.sealedBy === "seal_timeout" || input.sealedBy === "dispose" ?
        "censored" : "reliable"
      turn.deferFinalization = input.deferFinalization === true
      turn.awaitingFinalization = turn.deferFinalization || turn.predictionStatus === "pending"
      if (!turn.awaitingFinalization) finalize(turn)
      return true
    },
    finalizeTurn: ({ sessionID, turnOrdinal }) => {
      const turn = sessions.get(sessionID)?.turns.get(turnOrdinal)
      if (!turn) return false
      turn.deferFinalization = false
      return finalize(turn)
    },
    deleteSession: (sessionID) => clearSession(sessionID, "session_deleted"),
    getCounters: () => ({ ...counters }),
    getMapSizes: () => ({ sessions: sessions.size, reuseSessions: reuseBySession.size }),
    dispose: () => { for (const sessionID of [...sessions.keys()]) clearSession(sessionID, "dispose") },
  }
}
