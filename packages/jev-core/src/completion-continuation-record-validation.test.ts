import { describe, expect, test } from "bun:test"
import {
  selectLatestCompletionContinuationCountersByProcess,
  validateCompletionContinuationCounterDelta,
  validateCompletionContinuationEntry,
  validateCompletionContinuationObservation,
} from "./completion-continuation-record-validation"

const validObservation = {
  kind: "observation",
  schemaVersion: 1,
  questionVersion: 1,
  recordedAt: "2026-09-30T12:00:00.000Z",
  sessionID: "ses_w2",
  ordinal: 4,
  counterEpoch: 0,
  inputDigests: {
    todoStatus: "sha256:todos",
    transcript: "sha256:transcript",
    diff: "sha256:diff",
    boulder: "sha256:boulder",
  },
  inputTruncations: {
    todoItems: false,
    todoContent: false,
    transcriptMessages: false,
    transcriptContent: false,
    diffPaths: false,
    diffContent: false,
    boulderContent: false,
    state: false,
  },
  isContinuationCandidate: true,
  probabilities: {
    actuallyComplete: 0.11,
    progressing: 0.29,
    stuck: 0.91,
  },
  thresholdLabels: {
    actuallyComplete: "would_false",
    progressing: "would_false",
    stuck: "would_true",
  },
  confidenceThreshold: 0.8,
  heuristicFacts: {
    gauntletOutcome: "continuation_scheduled",
    todoComplete: false,
    promiseComplete: false,
    todoProgress: false,
    stagnationStop: false,
  },
  outcomeFacts: {
    actuallyComplete: false,
    progressing: false,
    stuck: true,
  },
  outcomeStatus: "observed",
  outcomeClosedBy: "unchanged_next_idle",
  predictionStatus: "filled",
  notDispatchedReason: null,
  unavailableReason: null,
  resolvedModel: "typesafe/jev-1.13.0",
  latencyMs: 84,
  invalidAnswerCount: 0,
} as const

const validPreInputSkips = {
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
} as const

const validCounters = {
  starts: 5,
  preInputSkips: validPreInputSkips,
  dispatchesDropped: 1,
  recordsEvicted: 2,
  censoredWindows: 3,
  malformedLines: 1,
  malformedWriteRejections: 1,
  recordsLostToCap: 2,
  sinkTruncations: 1,
} as const

function counterDelta(counterEpoch: number, monotonicSeq: number, starts = 5) {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-30T12:00:00.000Z",
    processId: "process-w2",
    counterEpoch,
    monotonicSeq,
    counters: { ...validCounters, starts },
  } as const
}

describe("completion-continuation record validation", () => {
  test("#given a complete observation #when validating #then it is accepted", () => {
    expect(validateCompletionContinuationObservation(validObservation)).toBe(true)
    expect(validateCompletionContinuationEntry(validObservation)).toBe(true)
  })

  test("#given a complete counter delta #when validating #then it is accepted", () => {
    const entry = counterDelta(2, 3)

    expect(validateCompletionContinuationCounterDelta(entry)).toBe(true)
    expect(validateCompletionContinuationEntry(entry)).toBe(true)
  })

  test.each([
    ["null", null],
    ["a non-object", "observation"],
    ["a truncated JSON line", '{"kind":"observation"'],
    ["a missing discriminant", (({ kind: _kind, ...entry }) => entry)(validObservation)],
    ["an unknown kind", { ...validObservation, kind: "future" }],
  ])("#given %s #when validating the entry #then it is rejected", (_name, entry) => {
    expect(validateCompletionContinuationEntry(entry)).toBe(false)
  })

  test.each([
    ["a top-level observation key", { ...validObservation, futureField: true }],
    [
      "a nested digest key",
      { ...validObservation, inputDigests: { ...validObservation.inputDigests, futureDigest: "x" } },
    ],
    ["an observation-only counter key", { ...counterDelta(0, 1), outcomeFacts: validObservation.outcomeFacts }],
  ])("#given %s #when validating exact keys #then it is rejected", (_name, entry) => {
    expect(validateCompletionContinuationEntry(entry)).toBe(false)
  })

  test.each([
    [
      "a string probability",
      { ...validObservation, probabilities: { ...validObservation.probabilities, stuck: "0.91" } },
    ],
    [
      "a probability above one",
      { ...validObservation, probabilities: { ...validObservation.probabilities, stuck: 1.01 } },
    ],
    [
      "an unknown outcome closure",
      { ...validObservation, outcomeClosedBy: "process_exit" },
    ],
    [
      "an unknown outcome truth",
      { ...validObservation, outcomeFacts: { ...validObservation.outcomeFacts, stuck: "yes" } },
    ],
  ])("#given %s #when validating the observation #then it is rejected", (_name, entry) => {
    expect(validateCompletionContinuationObservation(entry)).toBe(false)
  })

  test("rejects a heuristic label presented as outcome truth", () => {
    // given
    const circularEntry = {
      ...validObservation,
      outcomeFacts: {
        ...validObservation.outcomeFacts,
        stuck: validObservation.heuristicFacts.gauntletOutcome,
      },
    }

    // when
    const accepted = validateCompletionContinuationObservation(circularEntry)

    // then
    expect(accepted).toBe(false)
  })

  test("#given a censored timeout #when validating #then it remains distinct from stuck", () => {
    const censored = {
      ...validObservation,
      outcomeFacts: {
        actuallyComplete: "unknown",
        progressing: "unknown",
        stuck: "unknown",
      },
      outcomeStatus: "censored",
      outcomeClosedBy: "timeout",
    }

    expect(validateCompletionContinuationObservation(censored)).toBe(true)
  })
})

describe("completion-continuation counter selection", () => {
  test("#given stale counters arrive last #when selecting #then the highest epoch and sequence wins", () => {
    const selected = selectLatestCompletionContinuationCountersByProcess([
      counterDelta(2, 4, 9),
      counterDelta(1, 99, 8),
      counterDelta(2, 3, 7),
    ])

    expect(selected.get("process-w2")?.counterEpoch).toBe(2)
    expect(selected.get("process-w2")?.monotonicSeq).toBe(4)
    expect(selected.get("process-w2")?.counters.starts).toBe(9)
  })
})
