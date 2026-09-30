import type {
  CompletionContinuationCounterDelta,
  CompletionContinuationCounters,
  CompletionContinuationPreInputSkips,
} from "@oh-my-opencode/jev-core"

type MutableCounters = {
  -readonly [Key in keyof CompletionContinuationCounters]: CompletionContinuationCounters[Key]
}

export type CompletionContinuationSinkCounterState = {
  readonly processId: string
  readonly now: () => number
  readonly getCounters: (() => CompletionContinuationCounters) | undefined
  epoch: number
  sequence: number
  baseline: CompletionContinuationCounters
  source: MutableCounters
  retainedObservations: number
  localMalformedRejections: number
  recordsLostToCap: number
  sinkTruncations: number
}

function emptyPreInputSkips(): CompletionContinuationPreInputSkips {
  return {
    alreadyComplete: 0,
    recovering: 0,
    cancelled: 0,
    syncHandoff: 0,
    tokenLimit: 0,
    recentAbort: 0,
    backgroundTasks: 0,
    assistantAborted: 0,
    pendingQuestion: 0,
    internalContinuationPending: 0,
    messagesUnavailable: 0,
    todosUnavailable: 0,
  }
}

export function emptyCompletionContinuationCounters(): CompletionContinuationCounters {
  return {
    starts: 0,
    preInputSkips: emptyPreInputSkips(),
    dispatchesDropped: 0,
    recordsEvicted: 0,
    censoredWindows: 0,
    malformedLines: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
}

export function createCompletionContinuationSinkCounterState(
  processId: string,
  now: () => number,
  getCounters: (() => CompletionContinuationCounters) | undefined,
): CompletionContinuationSinkCounterState {
  const empty = emptyCompletionContinuationCounters()
  return {
    processId,
    now,
    getCounters,
    epoch: 0,
    sequence: 0,
    baseline: empty,
    source: { ...empty },
    retainedObservations: 0,
    localMalformedRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
}

function refreshSource(state: CompletionContinuationSinkCounterState): CompletionContinuationCounters {
  const current = state.getCounters?.() ?? state.source
  state.source = { ...current }
  state.recordsLostToCap = Math.max(state.recordsLostToCap, current.recordsLostToCap)
  state.sinkTruncations = Math.max(state.sinkTruncations, current.sinkTruncations)
  return current
}

function epochValue(current: number, baseline: number, retained = 0): number {
  return Math.max(0, current - baseline) + retained
}

function snapshotPreInputSkips(
  current: CompletionContinuationPreInputSkips,
  baseline: CompletionContinuationPreInputSkips,
): CompletionContinuationPreInputSkips {
  return {
    alreadyComplete: epochValue(current.alreadyComplete, baseline.alreadyComplete),
    recovering: epochValue(current.recovering, baseline.recovering),
    cancelled: epochValue(current.cancelled, baseline.cancelled),
    syncHandoff: epochValue(current.syncHandoff, baseline.syncHandoff),
    tokenLimit: epochValue(current.tokenLimit, baseline.tokenLimit),
    recentAbort: epochValue(current.recentAbort, baseline.recentAbort),
    backgroundTasks: epochValue(current.backgroundTasks, baseline.backgroundTasks),
    assistantAborted: epochValue(current.assistantAborted, baseline.assistantAborted),
    pendingQuestion: epochValue(current.pendingQuestion, baseline.pendingQuestion),
    internalContinuationPending: epochValue(
      current.internalContinuationPending,
      baseline.internalContinuationPending,
    ),
    messagesUnavailable: epochValue(current.messagesUnavailable, baseline.messagesUnavailable),
    todosUnavailable: epochValue(current.todosUnavailable, baseline.todosUnavailable),
  }
}

export function snapshotCompletionContinuationSinkCounters(
  state: CompletionContinuationSinkCounterState,
): CompletionContinuationCounters {
  const current = refreshSource(state)
  const baseline = state.baseline
  return {
    starts: epochValue(current.starts, baseline.starts, state.retainedObservations),
    preInputSkips: snapshotPreInputSkips(current.preInputSkips, baseline.preInputSkips),
    dispatchesDropped: epochValue(current.dispatchesDropped, baseline.dispatchesDropped),
    recordsEvicted: epochValue(current.recordsEvicted, baseline.recordsEvicted),
    censoredWindows: epochValue(current.censoredWindows, baseline.censoredWindows),
    malformedLines: epochValue(current.malformedLines, baseline.malformedLines),
    malformedWriteRejections: epochValue(
      current.malformedWriteRejections,
      baseline.malformedWriteRejections,
      state.localMalformedRejections,
    ),
    recordsLostToCap: state.recordsLostToCap,
    sinkTruncations: state.sinkTruncations,
  }
}

export function recordCompletionContinuationObservation(
  state: CompletionContinuationSinkCounterState,
): void {
  if (state.getCounters !== undefined) return
  state.source.starts += 1
}

export function ingestCompletionContinuationCounterDelta(
  state: CompletionContinuationSinkCounterState,
  entry: CompletionContinuationCounterDelta,
): void {
  if (entry.processId !== state.processId) return
  state.source = { ...entry.counters }
  state.sequence = Math.max(state.sequence, entry.monotonicSeq)
  state.recordsLostToCap = Math.max(state.recordsLostToCap, entry.counters.recordsLostToCap)
  state.sinkTruncations = Math.max(state.sinkTruncations, entry.counters.sinkTruncations)
}

export function recordCompletionContinuationMalformedWrite(
  state: CompletionContinuationSinkCounterState,
): void {
  state.localMalformedRejections += 1
}

export function beginCompletionContinuationCounterEpoch(
  state: CompletionContinuationSinkCounterState,
  lostObservations: number,
  retainedObservations: number,
): void {
  const current = refreshSource(state)
  state.epoch += 1
  state.baseline = { ...current }
  state.retainedObservations = retainedObservations
  state.localMalformedRejections = 0
  state.recordsLostToCap += lostObservations
  state.sinkTruncations += 1
}

export function discardRetainedCompletionContinuationObservation(
  state: CompletionContinuationSinkCounterState,
): void {
  if (state.retainedObservations === 0) return
  state.retainedObservations -= 1
  state.recordsLostToCap += 1
}

export function nextCompletionContinuationCounterDelta(
  state: CompletionContinuationSinkCounterState,
): CompletionContinuationCounterDelta {
  state.sequence += 1
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: new Date(state.now()).toISOString(),
    processId: state.processId,
    counterEpoch: state.epoch,
    monotonicSeq: state.sequence,
    counters: snapshotCompletionContinuationSinkCounters(state),
  }
}
