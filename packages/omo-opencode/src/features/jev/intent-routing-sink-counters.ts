import type {
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
} from "@oh-my-opencode/jev-core"

type MutableCounters = {
  -readonly [Key in keyof IntentRoutingCounters]: IntentRoutingCounters[Key]
}

export type IntentRoutingSinkCounterState = {
  readonly processId: string
  readonly now: () => number
  readonly getCounters: (() => IntentRoutingCounters) | undefined
  epoch: number
  sequence: number
  baseline: IntentRoutingCounters
  source: MutableCounters
  retainedObservations: number
  localMalformedRejections: number
  recordsLostToCap: number
  sinkTruncations: number
}

export function emptyIntentRoutingCounters(): IntentRoutingCounters {
  return {
    turnsSeen: 0,
    turnsGatedOut: 0,
    turnsSynthetic: 0,
    recordsCreated: 0,
    recordsEvicted: 0,
    orphanObservations: 0,
    unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0,
    dispatchesDropped: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
}

export function createIntentRoutingSinkCounterState(
  processId: string,
  now: () => number,
  getCounters: (() => IntentRoutingCounters) | undefined,
): IntentRoutingSinkCounterState {
  const empty = emptyIntentRoutingCounters()
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

function refreshSource(state: IntentRoutingSinkCounterState): IntentRoutingCounters {
  const current = state.getCounters?.() ?? state.source
  state.source = { ...current }
  state.recordsLostToCap = Math.max(state.recordsLostToCap, current.recordsLostToCap)
  state.sinkTruncations = Math.max(state.sinkTruncations, current.sinkTruncations)
  return current
}

function epochValue(current: number, baseline: number, retained = 0): number {
  return Math.max(0, current - baseline) + retained
}

export function snapshotIntentRoutingSinkCounters(
  state: IntentRoutingSinkCounterState,
): IntentRoutingCounters {
  const current = refreshSource(state)
  const baseline = state.baseline
  return {
    turnsSeen: epochValue(current.turnsSeen, baseline.turnsSeen, state.retainedObservations),
    turnsGatedOut: epochValue(current.turnsGatedOut, baseline.turnsGatedOut),
    turnsSynthetic: epochValue(current.turnsSynthetic, baseline.turnsSynthetic),
    recordsCreated: epochValue(
      current.recordsCreated,
      baseline.recordsCreated,
      state.retainedObservations,
    ),
    recordsEvicted: epochValue(current.recordsEvicted, baseline.recordsEvicted),
    orphanObservations: epochValue(current.orphanObservations, baseline.orphanObservations),
    unscorableResumeCalls: epochValue(
      current.unscorableResumeCalls,
      baseline.unscorableResumeCalls,
    ),
    unscorableUnknownCalls: epochValue(
      current.unscorableUnknownCalls,
      baseline.unscorableUnknownCalls,
    ),
    dispatchesDropped: epochValue(current.dispatchesDropped, baseline.dispatchesDropped),
    malformedWriteRejections: epochValue(
      current.malformedWriteRejections,
      baseline.malformedWriteRejections,
      state.localMalformedRejections,
    ),
    recordsLostToCap: state.recordsLostToCap,
    sinkTruncations: state.sinkTruncations,
  }
}

export function recordIntentRoutingObservation(
  state: IntentRoutingSinkCounterState,
): void {
  if (state.getCounters !== undefined) return
  state.source.turnsSeen += 1
  state.source.recordsCreated += 1
}

export function ingestIntentRoutingCounterDelta(
  state: IntentRoutingSinkCounterState,
  entry: IntentRoutingCounterDelta,
): void {
  if (entry.processId !== state.processId) return
  state.source = { ...entry.counters }
  state.sequence = Math.max(state.sequence, entry.monotonicSeq)
  state.recordsLostToCap = Math.max(state.recordsLostToCap, entry.counters.recordsLostToCap)
  state.sinkTruncations = Math.max(state.sinkTruncations, entry.counters.sinkTruncations)
}

export function recordIntentRoutingMalformedWrite(
  state: IntentRoutingSinkCounterState,
): void {
  state.localMalformedRejections += 1
}

export function beginIntentRoutingCounterEpoch(
  state: IntentRoutingSinkCounterState,
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

export function discardRetainedIntentRoutingObservation(
  state: IntentRoutingSinkCounterState,
): void {
  if (state.retainedObservations === 0) return
  state.retainedObservations -= 1
  state.recordsLostToCap += 1
}

export function nextIntentRoutingCounterDelta(
  state: IntentRoutingSinkCounterState,
): IntentRoutingCounterDelta {
  state.sequence += 1
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: new Date(state.now()).toISOString(),
    processId: state.processId,
    counterEpoch: state.epoch,
    monotonicSeq: state.sequence,
    counters: snapshotIntentRoutingSinkCounters(state),
  }
}
