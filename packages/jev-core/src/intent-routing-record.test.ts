import { describe, expect, test } from "bun:test"
import { resolveIntentRoutingCounterDeltas } from "./intent-routing-counter-reader"
import {
  INTENT_ROUTING_CONTINUATION_LEXICON,
  isIntentRoutingContinuationCandidate,
} from "./intent-routing-record"
import {
  validateIntentRoutingCounterDelta,
  validateIntentRoutingEntry,
  validateIntentRoutingObservationRecord,
} from "./intent-routing-record-validation"

const observation = {
  kind: "observation",
  schemaVersion: 1,
  questionVersion: 1,
  recordedAt: "2026-09-24T12:00:00.000Z",
  sessionID: "session-1",
  turnOrdinal: 1,
  dedupKey: "dedup-1",
  reuseKey: "reuse-1",
  predictionReused: false,
  promptHeadChars: "implement the routing contract",
  promptFullSha256: "a".repeat(64),
  promptChars: 30,
  truncatedInput: false,
  isContinuationCandidate: false,
  predictionStatus: "filled",
  notDispatchedReason: null,
  unavailableReason: null,
  resolvedModel: "jev-2026-09-24",
  latencyMs: 125,
  answers: {
    intent: {
      choice: "implementation",
      confidence: 0.9,
      probabilities: { implementation: 0.9, research: 0.1 },
      valid: true,
    },
    category: {
      choice: "deep",
      confidence: 0.8,
      probabilities: { deep: 0.8, none: 0.2 },
      valid: true,
    },
    subagent: {
      choice: "none",
      confidence: 0.95,
      probabilities: { none: 0.95, explore: 0.05 },
      valid: true,
    },
    ambiguous: { noul: 0.1, valid: true },
  },
  invalidAnswerCount: 0,
  observed: [
    {
      tool: "task",
      category: "deep",
      subagentType: null,
      requestedSubagentType: null,
      taskId: null,
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
      callID: "call-1",
    },
  ],
  observedAreAttempts: true,
  distinctCategoryCount: 1,
  distinctSubagentCount: 0,
  fanOutBucket: "one",
  correlationStatus: "reliable",
  sealedBy: "session_idle",
  counterEpoch: 0,
}

const counters = {
  turnsSeen: 5,
  turnsGatedOut: 1,
  turnsSynthetic: 1,
  recordsCreated: 3,
  recordsEvicted: 0,
  orphanObservations: 0,
  unscorableResumeCalls: 0,
  unscorableUnknownCalls: 0,
  dispatchesDropped: 0,
  malformedWriteRejections: 0,
  recordsLostToCap: 0,
  sinkTruncations: 0,
}

function counterDelta(monotonicSeq: number, turnsSeen: number) {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-24T12:00:00.000Z",
    processId: "process-1",
    counterEpoch: 0,
    monotonicSeq,
    counters: { ...counters, turnsSeen },
  }
}

describe("intent-routing record validation", () => {
  test("#given a fully populated observation #when validating #then it is accepted", () => {
    expect(validateIntentRoutingObservationRecord(observation)).toBe(true)
    expect(validateIntentRoutingEntry(observation)).toBe(true)
  })

  test("#given a counter delta #when validating #then it is accepted", () => {
    const entry = counterDelta(1, 5)
    expect(validateIntentRoutingCounterDelta(entry)).toBe(true)
    expect(validateIntentRoutingEntry(entry)).toBe(true)
  })

  test("#given an unknown entry kind #when validating #then it is rejected", () => {
    expect(validateIntentRoutingEntry({ ...observation, kind: "unknown" })).toBe(false)
  })

  test.each(["sealedBy", "correlationStatus"] as const)(
    "#given an observation missing %s #when validating #then it is rejected",
    (field) => {
      const incomplete = Object.fromEntries(Object.entries(observation).filter(([key]) => key !== field))
      expect(validateIntentRoutingObservationRecord(incomplete)).toBe(false)
    },
  )

  test("#given ambiguous confidence #when validating #then it is rejected", () => {
    const invalid = {
      ...observation,
      answers: {
        ...observation.answers,
        ambiguous: { ...observation.answers.ambiguous, confidence: 0.9 },
      },
    }
    expect(validateIntentRoutingObservationRecord(invalid)).toBe(false)
  })

  test("#given sealedBy evicted #when validating #then it is rejected", () => {
    expect(validateIntentRoutingObservationRecord({ ...observation, sealedBy: "evicted" })).toBe(false)
  })
})

describe("intent-routing counter resolution", () => {
  test("#given repeated process snapshots #when resolving #then the highest sequence replaces earlier values", () => {
    const resolved = resolveIntentRoutingCounterDeltas([
      counterDelta(1, 5),
      counterDelta(2, 8),
    ])
    expect(resolved.get("process-1")?.monotonicSeq).toBe(2)
    expect(resolved.get("process-1")?.counters.turnsSeen).toBe(8)
  })
})

describe("intent-routing continuation cohort", () => {
  test("#given the published lexicon #when inspected #then it is exact and frozen", () => {
    expect(INTENT_ROUTING_CONTINUATION_LEXICON).toEqual([
      "continue",
      "go on",
      "go ahead",
      "keep going",
      "next",
      "proceed",
      "resume",
      "yes",
      "ok",
      "do it",
      "carry on",
      "more",
    ])
    expect(Object.isFrozen(INTENT_ROUTING_CONTINUATION_LEXICON)).toBe(true)
  })

  test("#given lexicon prompts with trailing punctuation #when classifying #then they are candidates", () => {
    for (const phrase of INTENT_ROUTING_CONTINUATION_LEXICON) {
      expect(isIntentRoutingContinuationCandidate(`${phrase}!!!`), phrase).toBe(true)
    }
  })

  test("#given a non-lexicon prompt #when classifying #then it is not a candidate", () => {
    expect(isIntentRoutingContinuationCandidate("continue please")).toBe(false)
  })
})
