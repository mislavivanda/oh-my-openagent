import type { IntentRoutingCounters } from "@oh-my-opencode/jev-core"

export type MutableIntentRoutingCounters = {
  -readonly [Key in keyof IntentRoutingCounters]: IntentRoutingCounters[Key]
}

export function createEmptyIntentRoutingCounters(): MutableIntentRoutingCounters {
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

export function copyIntentRoutingCounters(
  counters: IntentRoutingCounters,
): MutableIntentRoutingCounters {
  return { ...counters }
}

export function mergeLatestSourceCounters(
  target: MutableIntentRoutingCounters,
  source: IntentRoutingCounters,
): void {
  target.turnsSeen = Math.max(target.turnsSeen, source.turnsSeen)
  target.turnsGatedOut = Math.max(target.turnsGatedOut, source.turnsGatedOut)
  target.turnsSynthetic = Math.max(target.turnsSynthetic, source.turnsSynthetic)
  target.recordsCreated = Math.max(target.recordsCreated, source.recordsCreated)
  target.recordsEvicted = Math.max(target.recordsEvicted, source.recordsEvicted)
  target.orphanObservations = Math.max(target.orphanObservations, source.orphanObservations)
  target.unscorableResumeCalls = Math.max(target.unscorableResumeCalls, source.unscorableResumeCalls)
  target.unscorableUnknownCalls = Math.max(target.unscorableUnknownCalls, source.unscorableUnknownCalls)
  target.dispatchesDropped = Math.max(target.dispatchesDropped, source.dispatchesDropped)
}

export function rebaseCorpusCounters(
  target: MutableIntentRoutingCounters,
  latest: IntentRoutingCounters,
  baseline: IntentRoutingCounters,
  retainedObservations: number,
): void {
  target.turnsSeen = Math.max(target.turnsSeen, latest.turnsSeen - baseline.turnsSeen)
  target.turnsGatedOut = Math.max(target.turnsGatedOut, latest.turnsGatedOut - baseline.turnsGatedOut)
  target.turnsSynthetic = Math.max(target.turnsSynthetic, latest.turnsSynthetic - baseline.turnsSynthetic)
  target.recordsEvicted = Math.max(target.recordsEvicted, latest.recordsEvicted - baseline.recordsEvicted)
  target.recordsCreated = Math.max(
    target.recordsCreated,
    latest.recordsCreated - baseline.recordsCreated,
    retainedObservations + target.recordsEvicted,
  )
  target.orphanObservations = Math.max(
    target.orphanObservations,
    latest.orphanObservations - baseline.orphanObservations,
  )
  target.unscorableResumeCalls = Math.max(
    target.unscorableResumeCalls,
    latest.unscorableResumeCalls - baseline.unscorableResumeCalls,
  )
  target.unscorableUnknownCalls = Math.max(
    target.unscorableUnknownCalls,
    latest.unscorableUnknownCalls - baseline.unscorableUnknownCalls,
  )
  target.dispatchesDropped = Math.max(
    target.dispatchesDropped,
    latest.dispatchesDropped - baseline.dispatchesDropped,
  )
}

export function addIntentRoutingCounters(
  target: MutableIntentRoutingCounters,
  source: IntentRoutingCounters,
): void {
  target.turnsSeen += source.turnsSeen
  target.turnsGatedOut += source.turnsGatedOut
  target.turnsSynthetic += source.turnsSynthetic
  target.recordsCreated += source.recordsCreated
  target.recordsEvicted += source.recordsEvicted
  target.orphanObservations += source.orphanObservations
  target.unscorableResumeCalls += source.unscorableResumeCalls
  target.unscorableUnknownCalls += source.unscorableUnknownCalls
  target.dispatchesDropped += source.dispatchesDropped
  target.malformedWriteRejections += source.malformedWriteRejections
  target.recordsLostToCap += source.recordsLostToCap
  target.sinkTruncations += source.sinkTruncations
}
