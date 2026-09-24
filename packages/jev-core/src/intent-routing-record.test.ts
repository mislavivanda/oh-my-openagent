import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_CONTINUATION_LEXICON,
  selectLatestCounterDeltasByProcess,
  validateIntentRoutingCounterDelta,
  validateIntentRoutingEntry,
  validateIntentRoutingObservationRecord,
  type IntentRoutingCounterDelta,
  type IntentRoutingObservationRecord,
} from "./intent-routing-record"

const validObservation = {
  kind: "observation",
  schemaVersion: 1,
  questionVersion: 1,
  recordedAt: "2026-09-24T12:00:00.000Z",
  sessionID: "session-1",
  turnOrdinal: 3,
  dedupKey: "dedup-1",
  reuseKey: "reuse-1",
  predictionReused: false,
  promptHeadChars: "delegate the investigation",
  promptFullSha256: "a".repeat(64),
  promptChars: 26,
  truncatedInput: false,
  isContinuationCandidate: false,
  predictionStatus: "filled",
  notDispatchedReason: null,
  unavailableReason: null,
  resolvedModel: "jev-2026-09-01",
  latencyMs: 42,
  answers: {
    intent: {
      choice: "delegate",
      confidence: 0.9,
      probabilities: { delegate: 0.9, direct: 0.1 },
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
      confidence: 0.7,
      probabilities: { explore: 0.3, none: 0.7 },
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
  sealedBy: "next_turn",
  counterEpoch: 0,
} satisfies IntentRoutingObservationRecord

const validCounterDelta = {
  kind: "counter_delta",
  schemaVersion: 1,
  recordedAt: "2026-09-24T12:00:01.000Z",
  processId: "process-1",
  counterEpoch: 0,
  monotonicSeq: 1,
  counters: {
    turnsSeen: 4,
    turnsGatedOut: 1,
    turnsSynthetic: 1,
    recordsCreated: 2,
    recordsInFlight: 0,
    recordsEvicted: 0,
    orphanObservations: 0,
    unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0,
    dispatchesDropped: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  },
} satisfies IntentRoutingCounterDelta

describe("intent-routing JSONL entry validation", () => {
  describe("#given a fully populated observation entry", () => {
    describe("#when validating either the observation arm or the union", () => {
      test("#then both validators accept it", () => {
        expect(validateIntentRoutingObservationRecord(validObservation)).toBe(true)
        expect(validateIntentRoutingEntry(validObservation)).toBe(true)
      })
    })
  })

  describe("#given a counter-delta entry", () => {
    describe("#when validating either the counter arm or the union", () => {
      test("#then both validators accept it", () => {
        expect(validateIntentRoutingCounterDelta(validCounterDelta)).toBe(true)
        expect(validateIntentRoutingEntry(validCounterDelta)).toBe(true)
      })
    })
  })

  describe("#given an entry with an unknown discriminator", () => {
    describe("#when validating the union", () => {
      test("#then it is rejected", () => {
        expect(validateIntentRoutingEntry({ kind: "future_entry" })).toBe(false)
      })
    })
  })

  describe("#given an observation missing a finalization field", () => {
    describe("#when validating the observation arm", () => {
      test.each(["sealedBy", "correlationStatus"])("#then missing %s is rejected", (missingKey) => {
        const incomplete = Object.fromEntries(
          Object.entries(validObservation).filter(([key]) => key !== missingKey),
        )

        expect(validateIntentRoutingObservationRecord(incomplete)).toBe(false)
      })
    })
  })

  describe("#given an ambiguous answer carrying SDK-absent confidence", () => {
    describe("#when validating the observation arm", () => {
      test("#then the extra field is rejected", () => {
        const observation = {
          ...validObservation,
          answers: {
            ...validObservation.answers,
            ambiguous: { ...validObservation.answers.ambiguous, confidence: 0.5 },
          },
        }

        expect(validateIntentRoutingObservationRecord(observation)).toBe(false)
      })
    })
  })

  describe("#given an observation sealed by eviction", () => {
    describe("#when validating the observation arm", () => {
      test("#then eviction is rejected because no evicted record is written", () => {
        expect(
          validateIntentRoutingObservationRecord({ ...validObservation, sealedBy: "evicted" }),
        ).toBe(false)
      })
    })
  })
})

describe("counter-delta snapshot selection", () => {
  describe("#given two cumulative snapshots from one process", () => {
    describe("#when selecting the latest snapshot per process", () => {
      test("#then the highest sequence wins instead of summing both lines", () => {
        const latest = {
          ...validCounterDelta,
          monotonicSeq: 2,
          counters: { ...validCounterDelta.counters, turnsSeen: 7 },
        }

        const selected = selectLatestCounterDeltasByProcess([validCounterDelta, latest])

        expect(selected.size).toBe(1)
        expect(selected.get("process-1")?.monotonicSeq).toBe(2)
        expect(selected.get("process-1")?.counters.turnsSeen).toBe(7)
      })
    })
  })
})

describe("continuation cohort lexicon", () => {
  describe("#given the exported continuation phrases", () => {
    describe("#when inspecting the runtime contract", () => {
      test("#then the exact cohort lexicon is frozen", () => {
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
    })
  })
})
