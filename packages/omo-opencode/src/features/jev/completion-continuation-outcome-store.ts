import { type CompletionContinuationCounterDelta } from "@oh-my-opencode/jev-core"
import { emptyCompletionContinuationCounters } from "./completion-continuation-sink-counters"
import {
  buildCompletionContinuationObservation, classifyCompletionContinuationOutcome,
  completionContinuationPredictionFrom, createCompletionContinuationTimeoutPrediction,
  snapshotCompletionContinuationOutcomeRecord, UNKNOWN_COMPLETION_CONTINUATION_OUTCOME_FACTS,
} from "./completion-continuation-outcome-classification"
import {
  CompletionContinuationOutcomeStoreDisposedError, DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION,
  DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_SESSIONS, DEFAULT_COMPLETION_CONTINUATION_OUTCOME_WINDOW_MS,
  type CloseCompletionContinuationOutcomeInput, type CompletionContinuationOutcomeHandle,
  type CompletionContinuationOutcomeSession, type CompletionContinuationOutcomeSnapshot, type CompletionContinuationOutcomeState,
  type CompletionContinuationOutcomeStore, type CompletionContinuationOutcomeStoreOptions,
  type MutableCompletionContinuationOutcomeRecord,
} from "./completion-continuation-outcome-types"
const DEFAULT_CLOCK = {
  now: Date.now,
  schedule: (delayMs: number, callback: () => void) => {
    const timer = setTimeout(callback, delayMs)
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() }
  },
}
function positive(value: number | undefined, fallback: number): number { return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback }
function signature(snapshot: CompletionContinuationOutcomeSnapshot): string {
  return JSON.stringify(snapshot.inputDigests ?? snapshot.input ?? null)
}
export function createCompletionContinuationOutcomeStore(options: CompletionContinuationOutcomeStoreOptions = {}): CompletionContinuationOutcomeStore {
  const state: CompletionContinuationOutcomeState = {
    sessions: new Map(), counters: { ...emptyCompletionContinuationCounters() }, pendingWrites: new Set(),
    clock: options.clock ?? DEFAULT_CLOCK,
    processId: options.processId ?? `outcome-store-${process.pid}-${Date.now()}`,
    outcomeWindowMs: positive(options.outcomeWindowMs, DEFAULT_COMPLETION_CONTINUATION_OUTCOME_WINDOW_MS),
    maxSessions: positive(options.maxSessions, DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_SESSIONS),
    maxRecordsPerSession: positive(options.maxRecordsPerSession, DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION),
    onEntry: options.onEntry ?? (() => undefined), access: 0, counterSequence: 0, disposing: false,
  }
  let disposed = false
  let disposePromise: Promise<void> | undefined
  function trackWrite(result: boolean | void | Promise<boolean | void>): void {
    if (!(result instanceof Promise)) return
    let tracked: Promise<void>
    tracked = result.then(() => undefined, () => undefined).finally(() => state.pendingWrites.delete(tracked))
    state.pendingWrites.add(tracked)
  }
  function touch(record: MutableCompletionContinuationOutcomeRecord): void {
    state.access += 1
    record.lastAccess = state.access
    const session = state.sessions.get(record.handle.sessionID)
    if (session !== undefined) session.lastAccess = state.access
  }
  function remove(record: MutableCompletionContinuationOutcomeRecord): void {
    state.sessions.get(record.handle.sessionID)?.records.delete(record.handle.ordinal)
  }
  function finalize(record: MutableCompletionContinuationOutcomeRecord): boolean {
    if (record.appended || !record.heuristicTerminal || record.prediction === null || record.outcomeStatus === "pending") return false
    record.appended = true
    trackWrite(state.onEntry(buildCompletionContinuationObservation(record, new Date(state.clock.now()).toISOString())))
    if (!state.disposing) remove(record)
    return true
  }
  function close(record: MutableCompletionContinuationOutcomeRecord, input: CloseCompletionContinuationOutcomeInput): boolean {
    if (record.outcomeStatus !== "pending") return false
    record.timer?.cancel()
    record.timer = null
    record.outcomeStatus = input.status
    record.outcomeClosedBy = input.closedBy
    record.outcomeFacts = input.facts
    if (input.status === "censored") state.counters.censoredWindows += 1
    finalize(record)
    return true
  }
  function censor(record: MutableCompletionContinuationOutcomeRecord, closedBy: "timeout" | "dispose" | "session_deleted" | "human_intervention" | "evicted"): boolean {
    return close(record, { status: "censored", closedBy, facts: UNKNOWN_COMPLETION_CONTINUATION_OUTCOME_FACTS })
  }
  function forceTerminal(record: MutableCompletionContinuationOutcomeRecord): void {
    record.heuristicTerminal = true
    record.prediction ??= createCompletionContinuationTimeoutPrediction()
    finalize(record)
  }
  function evictRecord(record: MutableCompletionContinuationOutcomeRecord): void {
    censor(record, "evicted")
    forceTerminal(record)
    remove(record)
    state.counters.recordsEvicted += 1
  }
  function evictSession(session: CompletionContinuationOutcomeSession): void {
    for (const record of [...session.records.values()]) evictRecord(record)
    state.sessions.delete(session.sessionID)
  }
  function oldest<T extends { readonly lastAccess: number }>(values: Iterable<T>): T | undefined {
    let found: T | undefined
    for (const value of values) if (found === undefined || value.lastAccess < found.lastAccess) found = value
    return found
  }
  function ensureSession(sessionID: string): CompletionContinuationOutcomeSession {
    const existing = state.sessions.get(sessionID)
    if (existing !== undefined) return existing
    if (state.sessions.size >= state.maxSessions) {
      const victim = oldest(state.sessions.values())
      if (victim !== undefined) evictSession(victim)
    }
    state.access += 1
    const created = { sessionID, records: new Map(), nextOrdinal: 1, lastAccess: state.access, lastSignature: null, lastHandle: null, dirtySinceIdle: false }
    state.sessions.set(sessionID, created)
    return created
  }
  function find(handle: CompletionContinuationOutcomeHandle): MutableCompletionContinuationOutcomeRecord | undefined {
    return state.sessions.get(handle.sessionID)?.records.get(handle.ordinal)
  }
  function observeNextIdle(sessionID: string, next: CompletionContinuationOutcomeSnapshot): number {
    const session = state.sessions.get(sessionID)
    if (session === undefined) return 0
    let closed = 0
    for (const record of session.records.values()) {
      if (record.outcomeStatus !== "pending") continue
      const classified = classifyCompletionContinuationOutcome({ current: record.current, next, continuationActivity: record.continuationActivity, successfulContinuation: record.successfulContinuation })
      record.outcomeFacts = classified.facts
      if (classified.status === "observed" && close(record, { status: "observed", closedBy: classified.closedBy, facts: classified.facts })) closed += 1
    }
    return closed
  }
  function emitCounters(): void {
    state.counterSequence += 1
    const entry: CompletionContinuationCounterDelta = {
      kind: "counter_delta", schemaVersion: 1, recordedAt: new Date(state.clock.now()).toISOString(),
      processId: state.processId, counterEpoch: 0, monotonicSeq: state.counterSequence,
      counters: { ...state.counters, preInputSkips: { ...state.counters.preInputSkips } },
    }
    trackWrite(state.onEntry(entry))
  }
  async function awaitWrites(): Promise<void> {
    while (state.pendingWrites.size > 0) await Promise.all([...state.pendingWrites])
  }
  function start(input: Parameters<CompletionContinuationOutcomeStore["start"]>[0]): CompletionContinuationOutcomeHandle {
    if (disposed || state.disposing) throw new CompletionContinuationOutcomeStoreDisposedError()
    const existing = state.sessions.get(input.sessionID)
    const nextSignature = signature(input.snapshot)
    if (existing?.lastSignature === nextSignature && !existing.dirtySinceIdle && existing.lastHandle !== null) return existing.lastHandle
    observeNextIdle(input.sessionID, input.snapshot)
    const session = ensureSession(input.sessionID)
    if (session.records.size >= state.maxRecordsPerSession) {
      const victim = oldest(session.records.values())
      if (victim !== undefined) evictRecord(victim)
    }
    const handle = { sessionID: input.sessionID, ordinal: session.nextOrdinal }
    session.nextOrdinal += 1
    state.access += 1
    const record: MutableCompletionContinuationOutcomeRecord = {
      handle, current: input.snapshot, inputTruncations: input.inputTruncations,
      isContinuationCandidate: input.isContinuationCandidate, confidenceThreshold: input.confidenceThreshold,
      heuristicFacts: input.heuristicFacts, heuristicTerminal: false, prediction: null,
      outcomeStatus: "pending", outcomeClosedBy: null, outcomeFacts: UNKNOWN_COMPLETION_CONTINUATION_OUTCOME_FACTS,
      continuationActivity: false, successfulContinuation: false, appended: false, lastAccess: state.access, timer: null,
    }
    session.records.set(handle.ordinal, record)
    session.lastAccess = state.access
    session.lastSignature = nextSignature
    session.lastHandle = handle
    session.dirtySinceIdle = false
    state.counters.starts += 1
    const initial = classifyCompletionContinuationOutcome({ current: input.snapshot, continuationActivity: false, successfulContinuation: false })
    if (initial.status === "observed") close(record, { status: "observed", closedBy: initial.closedBy, facts: initial.facts })
    else {
      record.timer = state.clock.schedule(state.outcomeWindowMs, () => censor(record, "timeout"))
      record.timer.unref()
    }
    return handle
  }
  return {
    start,
    finalizeHeuristic: (handle, facts) => {
      const record = find(handle)
      if (record === undefined || record.heuristicTerminal) return false
      if (facts !== undefined) record.heuristicFacts = facts
      record.heuristicTerminal = true
      finalize(record)
      return true
    },
    resolvePrediction: (handle, result) => {
      const record = find(handle)
      if (record === undefined || record.prediction !== null) return false
      record.prediction = completionContinuationPredictionFrom(result)
      touch(record)
      finalize(record)
      return true
    },
    markPredictionNotDispatched: (handle, reason) => {
      const record = find(handle)
      if (record === undefined || record.prediction !== null) return false
      record.prediction = { ...createCompletionContinuationTimeoutPrediction(), predictionStatus: "not_dispatched", notDispatchedReason: reason, unavailableReason: null }
      if (reason === "max_inflight") state.counters.dispatchesDropped += 1
      finalize(record)
      return true
    },
    markContinuationActivity: (handle, activity) => {
      const record = find(handle)
      if (record === undefined || record.outcomeStatus !== "pending") return false
      record.continuationActivity = true
      record.successfulContinuation ||= activity.successful
      const session = state.sessions.get(handle.sessionID)
      if (session !== undefined) session.dirtySinceIdle = true
      const classified = classifyCompletionContinuationOutcome({ current: record.current, continuationActivity: true, successfulContinuation: record.successfulContinuation })
      record.outcomeFacts = classified.facts
      touch(record)
      return true
    },
    observeNextIdle,
    humanIntervention: (sessionID) => {
      const records = state.sessions.get(sessionID)?.records.values() ?? []
      let count = 0
      for (const record of records) if (censor(record, "human_intervention")) count += 1
      return count
    },
    deleteSession: async (sessionID) => {
      const session = state.sessions.get(sessionID)
      if (session === undefined) return
      for (const record of session.records.values()) { censor(record, "session_deleted"); forceTerminal(record) }
      emitCounters()
      await awaitWrites()
      state.sessions.delete(sessionID)
    },
    getRecord: (handle) => {
      const record = find(handle)
      return record === undefined ? undefined : snapshotCompletionContinuationOutcomeRecord(record)
    },
    getSessionRecords: (sessionID) => [...(state.sessions.get(sessionID)?.records.values() ?? [])].map(snapshotCompletionContinuationOutcomeRecord),
    getLatestPreviousSnapshot: (sessionID) => { const record = [...(state.sessions.get(sessionID)?.records.values() ?? [])].at(-1); return record === undefined ? undefined : { snapshot: record.current, continuationDispatched: record.continuationActivity } },
    getCounters: () => ({ ...state.counters, preInputSkips: { ...state.counters.preInputSkips } }),
    inspect: () => ({
      sessionCount: state.sessions.size,
      recordCount: [...state.sessions.values()].reduce((sum, session) => sum + session.records.size, 0),
      recordsEvicted: state.counters.recordsEvicted,
    }),
    dispose: async () => {
      disposePromise ??= (async () => {
        state.disposing = true
        for (const session of state.sessions.values()) {
          for (const record of session.records.values()) { censor(record, "dispose"); forceTerminal(record) }
        }
        emitCounters()
        await awaitWrites()
        state.sessions.clear()
        disposed = true
        state.disposing = false
      })()
      await disposePromise
    },
  }
}
