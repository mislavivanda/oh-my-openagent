import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_CONTINUATION_LEXICON,
  isIntentRoutingContinuationCandidate,
  selectLatestIntentRoutingCountersByProcess,
  validateIntentRoutingCounterDelta,
  validateIntentRoutingEntry,
  validateIntentRoutingObservationRecord,
} from "./index"

const validObservation = {
  kind: "observation",
  schemaVersion: 1,
  questionVersion: 1,
  recordedAt: "2026-09-24T12:00:00.000Z",
  sessionID: "ses_test",
  turnOrdinal: 3,
  dedupKey: "ses_test:message-3",
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
  resolvedModel: "typesafe/jev-1",
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
  observed: [
    {
      tool: "task",
      category: "deep",
      subagentType: "sisyphus-junior",
      requestedSubagentType: null,
      taskId: null,
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
      callID: "call_1",
    },
  ],
  observedAreAttempts: true,
  distinctCategoryCount: 1,
  distinctSubagentCount: 0,
  fanOutBucket: "one",
  correlationStatus: "reliable",
  sealedBy: "next_turn",
  counterEpoch: 0,
} as const

const validCounters = {
  turnsSeen: 8,
  turnsGatedOut: 2,
  turnsSynthetic: 1,
  recordsCreated: 5,
  recordsEvicted: 1,
  orphanObservations: 1,
  unscorableResumeCalls: 2,
  unscorableUnknownCalls: 1,
  dispatchesDropped: 0,
  malformedWriteRejections: 0,
  recordsLostToCap: 0,
  sinkTruncations: 0,
} as const

function counterDelta(monotonicSeq: number, recordsCreated = 5) {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-24T12:00:00.000Z",
    processId: "process-1",
    counterEpoch: 0,
    monotonicSeq,
    counters: { ...validCounters, recordsCreated },
  } as const
}

describe("intent-routing record validation", () => {
  test("#given a fully populated observation #when validating #then it is accepted", () => {
    expect(
      validateIntentRoutingObservationRecord(validObservation),
      "the fully populated observation contract should validate",
    ).toBe(true)
    expect(validateIntentRoutingEntry(validObservation)).toBe(true)
  })

  test("#given a counter snapshot #when validating #then it is accepted", () => {
    const entry = counterDelta(1)

    expect(validateIntentRoutingCounterDelta(entry)).toBe(true)
    expect(validateIntentRoutingEntry(entry)).toBe(true)
  })

  test.each([
    ["an unknown kind", { ...validObservation, kind: "future" }],
    ["a missing discriminator", (({ kind: _kind, ...entry }) => entry)(validObservation)],
    ["null", null],
    ["a non-object", "observation"],
    ["an array", [validObservation]],
    ["an extra unknown field", { ...validObservation, futureField: true }],
    ["a non-numeric turn ordinal", { ...validObservation, turnOrdinal: "3" }],
    ["a non-numeric monotonic sequence", { ...counterDelta(1), monotonicSeq: "1" }],
    ["an unknown sealedBy", { ...validObservation, sealedBy: "evicted" }],
    ["an unknown correlation status", { ...validObservation, correlationStatus: "uncertain" }],
  ])("#given %s #when validating the entry #then it is rejected", (_name, entry) => {
    expect(validateIntentRoutingEntry(entry)).toBe(false)
  })

  test.each([
    ["sealedBy", (({ sealedBy: _sealedBy, ...entry }) => entry)(validObservation)],
    [
      "correlationStatus",
      (({ correlationStatus: _correlationStatus, ...entry }) => entry)(validObservation),
    ],
  ])("#given an observation missing %s #when validating #then it is rejected", (_name, entry) => {
    expect(validateIntentRoutingObservationRecord(entry)).toBe(false)
  })

  test("#given ambiguous carries a confidence #when validating #then the extra field is rejected", () => {
    const entry = {
      ...validObservation,
      answers: {
        ...validObservation.answers,
        ambiguous: { ...validObservation.answers.ambiguous, confidence: 0.9 },
      },
    }

    expect(validateIntentRoutingObservationRecord(entry)).toBe(false)
  })
})

describe("intent-routing counter reader", () => {
  test("#given two snapshots for one process #when selecting counters #then only the highest sequence remains", () => {
    const selected = selectLatestIntentRoutingCountersByProcess([
      counterDelta(2, 7),
      counterDelta(1, 5),
    ])

    expect(selected.get("process-1")?.monotonicSeq).toBe(2)
    expect(selected.get("process-1")?.counters.recordsCreated).toBe(7)
  })
})

describe("intent-routing continuation cohort", () => {
  test("#given the published lexicon #when inspected #then it is frozen and reproducible", () => {
    expect(Object.isFrozen(INTENT_ROUTING_CONTINUATION_LEXICON)).toBe(true)
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
  })

  test.each([
    ["continue", true],
    ["go ahead!!!", true],
    ["please go ahead", false],
    ["continue with the implementation now", false],
  ])("#given %s #when classifying continuation intent #then it returns %s", (prompt, expected) => {
    expect(isIntentRoutingContinuationCandidate(prompt)).toBe(expected)
  })
})
