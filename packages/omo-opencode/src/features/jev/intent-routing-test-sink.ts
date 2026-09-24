import type { IntentRoutingSink } from "./intent-routing-sink"

export function createIntentRoutingTestSink(): IntentRoutingSink {
  return {
    processId: "intent-routing-test",
    filePath: "/tmp/intent-routing-test.jsonl",
    append: () => true,
    updateCounters: () => undefined,
    flushCounters: () => undefined,
    getCounters: () => ({
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
    }),
    getCounterEpoch: () => 0,
    dispose: () => undefined,
  }
}
