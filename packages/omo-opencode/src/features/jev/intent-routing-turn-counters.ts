import type { IntentRoutingCounters } from "@oh-my-opencode/jev-core"

export type MutableIntentRoutingCounters = {
  -readonly [Key in keyof IntentRoutingCounters]: number
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
