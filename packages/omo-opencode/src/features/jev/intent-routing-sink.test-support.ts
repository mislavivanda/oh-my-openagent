import type {
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import type { IntentRoutingProcessIdentity } from "./intent-routing-sink"

export const FIXED_NOW = Date.parse("2026-09-24T12:00:00.000Z")

export function counters(
  overrides: Partial<IntentRoutingCounters> = {},
): IntentRoutingCounters {
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
    ...overrides,
  }
}

export function observation(
  overrides: Partial<IntentRoutingObservationRecord> = {},
): IntentRoutingObservationRecord {
  return {
    kind: "observation",
    schemaVersion: 1,
    questionVersion: 1,
    recordedAt: "2026-09-24T12:00:00.000Z",
    sessionID: "ses_test",
    turnOrdinal: 1,
    dedupKey: "ses_test:message-1",
    reuseKey: "sha256:reuse",
    predictionReused: false,
    promptHeadChars: "continue",
    promptFullSha256: "a".repeat(64),
    promptChars: 8,
    truncatedInput: false,
    isContinuationCandidate: true,
    predictionStatus: "filled",
    notDispatchedReason: null,
    unavailableReason: null,
    resolvedModel: "jev-1.13.0",
    latencyMs: 42,
    answers: {
      intent: {
        choice: "delegate",
        confidence: 0.91,
        probabilities: { delegate: 0.91, act: 0.09 },
        valid: true,
      },
      category: {
        choice: "deep",
        confidence: 0.88,
        probabilities: { deep: 0.88, none: 0.12 },
        valid: true,
      },
      subagent: {
        choice: "none",
        confidence: 0.83,
        probabilities: { none: 0.83, explore: 0.17 },
        valid: true,
      },
      ambiguous: { noul: 0.14, valid: true },
    },
    invalidAnswerCount: 0,
    observed: [{
      tool: "task",
      category: "deep",
      subagentType: null,
      requestedSubagentType: null,
      taskId: null,
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
      callID: "call_1",
    }],
    observedAreAttempts: true,
    distinctCategoryCount: 1,
    distinctSubagentCount: 0,
    fanOutBucket: "one",
    correlationStatus: "reliable",
    sealedBy: "next_turn",
    counterEpoch: 0,
    ...overrides,
  }
}

export function processIdentity(pid: number): IntentRoutingProcessIdentity {
  return {
    pid,
    processStartEpochNanos: `${1_790_000_000_000_000_000n + BigInt(pid)}`,
    randomSuffix: `suffix${pid}`,
  }
}

export function processId(identity: IntentRoutingProcessIdentity): string {
  return `${identity.pid}-${identity.processStartEpochNanos}-${identity.randomSuffix}`
}

export function counterDelta(
  identity: IntentRoutingProcessIdentity,
  monotonicSeq: number,
  values: IntentRoutingCounters,
  counterEpoch = 0,
): IntentRoutingCounterDelta {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-24T12:00:00.000Z",
    processId: processId(identity),
    counterEpoch,
    monotonicSeq,
    counters: values,
  }
}
