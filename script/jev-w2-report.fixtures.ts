import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES,
  type CompletionContinuationCounterDelta,
  type CompletionContinuationCounters,
  type CompletionContinuationHeuristicFacts,
  type CompletionContinuationObservation,
  type CompletionContinuationOutcomeClosedBy,
} from "../packages/jev-core/src"

const RECORDED_AT = "2026-09-30T12:00:00.000Z"
const CLOSURES: readonly CompletionContinuationOutcomeClosedBy[] = [
  "unchanged_next_idle",
  "timeout",
  "tracked_work_complete",
  "tracked_work_progressed",
  "dispose",
  "session_deleted",
  "human_intervention",
  "evicted",
  null,
  "tracked_work_complete",
  "tracked_work_progressed",
  "unchanged_next_idle",
  null,
]

type PredictionFields = Pick<
  CompletionContinuationObservation,
  | "probabilities"
  | "thresholdLabels"
  | "predictionStatus"
  | "notDispatchedReason"
  | "unavailableReason"
  | "resolvedModel"
  | "invalidAnswerCount"
>

type OutcomeFields = Pick<
  CompletionContinuationObservation,
  "outcomeFacts" | "outcomeStatus" | "outcomeClosedBy"
>

function filledPrediction(
  actuallyComplete: boolean,
  progressing: boolean,
  stuck: boolean,
): PredictionFields {
  return {
    probabilities: {
      actuallyComplete: actuallyComplete ? 0.95 : 0.05,
      progressing: progressing ? 0.95 : 0.05,
      stuck: stuck ? 0.95 : 0.05,
    },
    thresholdLabels: {
      actuallyComplete: actuallyComplete ? "would_true" : "would_false",
      progressing: progressing ? "would_true" : "would_false",
      stuck: stuck ? "would_true" : "would_false",
    },
    predictionStatus: "filled", notDispatchedReason: null, unavailableReason: null,
    resolvedModel: "synthetic-jev", invalidAnswerCount: 0,
  }
}

function predictionFields(index: number): PredictionFields {
  if (index === 0 || index === 2 || index === 9) return filledPrediction(true, true, false)
  if (index === 1 || index === 6 || index === 11) return filledPrediction(false, false, true)
  if (index === 10) return filledPrediction(false, true, false)
  if (index === 3) {
    return {
      probabilities: { actuallyComplete: null, progressing: null, stuck: null },
      thresholdLabels: { actuallyComplete: "unavailable", progressing: "unavailable", stuck: "unavailable" },
      predictionStatus: "failed", notDispatchedReason: null, unavailableReason: "malformed_response",
      resolvedModel: null, invalidAnswerCount: 3,
    }
  }
  if (index === 4) {
    return {
      probabilities: { actuallyComplete: null, progressing: null, stuck: null },
      thresholdLabels: { actuallyComplete: "unavailable", progressing: "unavailable", stuck: "unavailable" },
      predictionStatus: "timeout", notDispatchedReason: null, unavailableReason: "timeout",
      resolvedModel: null, invalidAnswerCount: 0,
    }
  }
  if (index === 5) {
    return {
      probabilities: { actuallyComplete: null, progressing: null, stuck: null },
      thresholdLabels: { actuallyComplete: "unavailable", progressing: "unavailable", stuck: "unavailable" },
      predictionStatus: "not_dispatched", notDispatchedReason: "max_inflight", unavailableReason: null,
      resolvedModel: null, invalidAnswerCount: 0,
    }
  }
  return {
    probabilities: { actuallyComplete: 0.5, progressing: 0.5, stuck: 0.5 },
    thresholdLabels: { actuallyComplete: "uncertain", progressing: "uncertain", stuck: "uncertain" },
    predictionStatus: "filled", notDispatchedReason: null, unavailableReason: null,
    resolvedModel: "synthetic-jev", invalidAnswerCount: 0,
  }
}

function outcomeFields(closedBy: CompletionContinuationOutcomeClosedBy): OutcomeFields {
  switch (closedBy) {
    case "tracked_work_complete":
      return { outcomeStatus: "observed", outcomeClosedBy: closedBy, outcomeFacts: { actuallyComplete: true, progressing: true, stuck: false } }
    case "tracked_work_progressed":
      return { outcomeStatus: "observed", outcomeClosedBy: closedBy, outcomeFacts: { actuallyComplete: false, progressing: true, stuck: false } }
    case "unchanged_next_idle":
      return { outcomeStatus: "observed", outcomeClosedBy: closedBy, outcomeFacts: { actuallyComplete: false, progressing: false, stuck: true } }
    case "timeout":
    case "dispose":
    case "session_deleted":
    case "human_intervention":
    case "evicted":
      return { outcomeStatus: "censored", outcomeClosedBy: closedBy, outcomeFacts: { actuallyComplete: "unknown", progressing: "unknown", stuck: "unknown" } }
    case null:
      return { outcomeStatus: "pending", outcomeClosedBy: null, outcomeFacts: { actuallyComplete: "unknown", progressing: "unknown", stuck: "unknown" } }
  }
}

function heuristicFacts(index: number): CompletionContinuationHeuristicFacts {
  const gauntletOutcome = COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES[index]
  if (gauntletOutcome === undefined) throw new RangeError(`Missing gauntlet outcome at ${index}`)
  if (index === 0) {
    return { gauntletOutcome, todoComplete: true, promiseComplete: true, todoProgress: true, stagnationStop: false }
  }
  if (index === 1) {
    return { gauntletOutcome, todoComplete: false, promiseComplete: false, todoProgress: false, stagnationStop: true }
  }
  return { gauntletOutcome, todoComplete: null, promiseComplete: null, todoProgress: null, stagnationStop: null }
}

function observation(index: number): CompletionContinuationObservation {
  const closedBy = CLOSURES[index]
  if (closedBy === undefined) throw new RangeError(`Missing closure at ${index}`)
  return {
    kind: "observation", schemaVersion: 1, questionVersion: 1, recordedAt: RECORDED_AT,
    sessionID: `synthetic-${index + 1}`, ordinal: index + 1, counterEpoch: 1,
    inputDigests: {
      todoStatus: `todo-${index + 1}`,
      transcript: index % 2 === 0 ? `transcript-${index + 1}` : null,
      diff: index % 3 === 0 ? `diff-${index + 1}` : null,
      boulder: index % 4 === 0 ? `boulder-${index + 1}` : null,
    },
    inputTruncations: {
      todoItems: index % 8 === 0,
      todoContent: index % 8 === 1,
      transcriptMessages: index % 8 === 2,
      transcriptContent: index % 8 === 3,
      diffPaths: index % 8 === 4,
      diffContent: index % 8 === 5,
      boulderContent: index % 8 === 6,
      state: index % 8 === 7,
    },
    isContinuationCandidate: index % 2 === 0,
    confidenceThreshold: 0.8,
    heuristicFacts: heuristicFacts(index),
    latencyMs: index + 1,
    ...predictionFields(index),
    ...outcomeFields(closedBy),
  }
}

function counters(overrides: Partial<CompletionContinuationCounters>): CompletionContinuationCounters {
  return {
    starts: 0,
    preInputSkips: {
      alreadyComplete: 0, recovering: 0, cancelled: 0, syncHandoff: 0,
      tokenLimit: 0, recentAbort: 0, backgroundTasks: 0, assistantAborted: 0,
      pendingQuestion: 0, internalContinuationPending: 0,
      messagesUnavailable: 0, todosUnavailable: 0,
    },
    dispatchesDropped: 0, recordsEvicted: 0, censoredWindows: 0,
    malformedLines: 0, malformedWriteRejections: 0, recordsLostToCap: 0,
    sinkTruncations: 0, ...overrides,
  }
}

function delta(processId: string, counterEpoch: number, monotonicSeq: number, values: CompletionContinuationCounters): CompletionContinuationCounterDelta {
  return { kind: "counter_delta", schemaVersion: 1, recordedAt: RECORDED_AT, processId, counterEpoch, monotonicSeq, counters: values }
}

function jsonLines(entries: readonly object[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
}

export function writeJevW2SyntheticCorpus(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true })
  const records = COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES.map((_outcome, index) => observation(index))
  const allSkips = {
    alreadyComplete: 1, recovering: 1, cancelled: 1, syncHandoff: 1,
    tokenLimit: 1, recentAbort: 1, backgroundTasks: 1, assistantAborted: 1,
    pendingQuestion: 1, internalContinuationPending: 1,
    messagesUnavailable: 1, todosUnavailable: 1,
  }
  const p1 = counters({ starts: 11, preInputSkips: allSkips, dispatchesDropped: 3, recordsEvicted: 2, censoredWindows: 5, malformedLines: 2, malformedWriteRejections: 3, recordsLostToCap: 4, sinkTruncations: 2 })
  const p2 = counters({ starts: 4, dispatchesDropped: 1, recordsEvicted: 1, malformedWriteRejections: 1, recordsLostToCap: 1, sinkTruncations: 1 })
  writeFileSync(join(rootDir, "w2-main.jsonl"), jsonLines([
    ...records,
    delta("p1", 0, 50, counters({ starts: 999 })),
    delta("p1", 1, 1, counters({ starts: 10 })),
    delta("p1", 1, 2, p1),
    delta("p1", 0, 99, counters({ starts: 787 })),
  ]))
  writeFileSync(join(rootDir, "w2-second.jsonl"), jsonLines([delta("p2", 0, 1, p2)]))
  const sample = records.at(0)
  if (sample === undefined) throw new TypeError("Synthetic corpus requires one observation")
  writeFileSync(join(rootDir, "w2-malformed.jsonl"), [
    "{bad-json",
    JSON.stringify({ ...sample, outcomeClosedBy: "unknown_outcome" }),
    JSON.stringify({ ...sample, outcomeFacts: undefined }),
    "{\"kind\":\"observation\"",
    "",
  ].join("\n"))
}
