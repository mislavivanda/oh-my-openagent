import {
  COMPLETION_CONTINUATION_QUESTION_VERSION,
  type CompletionContinuationDecisionResult,
  type CompletionContinuationObservation,
  type CompletionContinuationOutcomeFacts,
} from "@oh-my-opencode/jev-core"
import type {
  ClassifyCompletionContinuationOutcomeInput,
  CompletionContinuationOutcomeClassification,
  CompletionContinuationOutcomeRecordSnapshot,
  CompletionContinuationOutcomeSnapshot,
  CompletionContinuationPredictionTerminal,
  MutableCompletionContinuationOutcomeRecord,
} from "./completion-continuation-outcome-types"

export const UNKNOWN_COMPLETION_CONTINUATION_OUTCOME_FACTS: CompletionContinuationOutcomeFacts = {
  actuallyComplete: "unknown",
  progressing: "unknown",
  stuck: "unknown",
}

type SnapshotFacts = {
  readonly trackedComplete: boolean
  readonly knownIncomplete: boolean
  readonly todoCompleted: number | null
  readonly todoDigest: string | null
  readonly boulderCompleted: number | null
  readonly boulderDigest: string | null
}

function snapshotFacts(snapshot: CompletionContinuationOutcomeSnapshot | undefined): SnapshotFacts {
  const todos = snapshot?.input?.todos
  const boulder = snapshot?.input?.boulder
  const todosKnown = todos !== undefined
  const boulderKnown = boulder !== undefined && boulder !== null
  const todoIncomplete = todosKnown
    ? todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
    : null
  const todoComplete = todoIncomplete === 0
  const boulderComplete = boulderKnown && boulder.total > 0 && boulder.remaining === 0
  const trackedComplete = todoComplete || boulderComplete
  const knownIncomplete = !trackedComplete && (
    (todoIncomplete !== null && todoIncomplete > 0)
    || (boulderKnown && boulder.total > 0 && boulder.remaining > 0)
  )
  return {
    trackedComplete,
    knownIncomplete,
    todoCompleted: todosKnown
      ? todos.filter((todo) => todo.status === "completed").length
      : null,
    todoDigest: typeof snapshot?.inputDigests?.todoStatus === "string"
      ? snapshot.inputDigests.todoStatus
      : null,
    boulderCompleted: boulderKnown ? boulder.completed : null,
    boulderDigest: typeof snapshot?.inputDigests?.boulder === "string"
      ? snapshot.inputDigests.boulder
      : null,
  }
}

function rose(current: number | null, next: number | null): boolean {
  return current !== null && next !== null && next > current
}

function advanced(current: string | null, next: string | null): boolean {
  return current !== null && next !== null && next !== current
}

function unchanged(current: string | null, next: string | null): boolean {
  return current !== null && next !== null && next === current
}

function hasComparisonShape(snapshot: CompletionContinuationOutcomeSnapshot | undefined): boolean {
  return snapshot?.input?.todos !== undefined
    && snapshot.input.boulder !== undefined
    && typeof snapshot.inputDigests?.todoStatus === "string"
    && snapshot.inputDigests.boulder !== undefined
}

export function classifyCompletionContinuationOutcome(
  input: ClassifyCompletionContinuationOutcomeInput,
): CompletionContinuationOutcomeClassification {
  const current = snapshotFacts(input.current)
  const next = snapshotFacts(hasComparisonShape(input.next) ? input.next : undefined)
  const trackedComplete = current.trackedComplete || next.trackedComplete
  if (trackedComplete) {
    return {
      status: "observed",
      closedBy: "tracked_work_complete",
      facts: { actuallyComplete: true, progressing: true, stuck: false },
    }
  }

  const progressed = rose(current.todoCompleted, next.todoCompleted)
    || advanced(current.todoDigest, next.todoDigest)
    || rose(current.boulderCompleted, next.boulderCompleted)
  if (progressed) {
    return {
      status: "observed",
      closedBy: "tracked_work_progressed",
      facts: {
        actuallyComplete: input.continuationActivity && current.knownIncomplete ? false : "unknown",
        progressing: true,
        stuck: false,
      },
    }
  }

  const stuck = input.successfulContinuation
    && input.next !== undefined
    && next.knownIncomplete
    && unchanged(current.todoDigest, next.todoDigest)
    && unchanged(current.boulderDigest, next.boulderDigest)
  if (stuck) {
    return {
      status: "observed",
      closedBy: "unchanged_next_idle",
      facts: { actuallyComplete: false, progressing: false, stuck: true },
    }
  }

  return {
    status: "pending",
    facts: {
      actuallyComplete: input.continuationActivity
        && current.knownIncomplete
        && (input.next === undefined || hasComparisonShape(input.next))
        ? false
        : "unknown",
      progressing: "unknown",
      stuck: "unknown",
    },
  }
}

export function completionContinuationPredictionFrom(
  result: CompletionContinuationDecisionResult,
): CompletionContinuationPredictionTerminal {
  return { ...result, notDispatchedReason: null }
}

export function createCompletionContinuationTimeoutPrediction(): CompletionContinuationPredictionTerminal {
  return {
    predictionStatus: "timeout", notDispatchedReason: null, unavailableReason: "timeout",
    resolvedModel: null, latencyMs: 0,
    probabilities: { actuallyComplete: null, progressing: null, stuck: null },
    thresholdLabels: { actuallyComplete: "unavailable", progressing: "unavailable", stuck: "unavailable" },
    invalidAnswerCount: 0, questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION,
  }
}

export function snapshotCompletionContinuationOutcomeRecord(
  record: MutableCompletionContinuationOutcomeRecord,
): CompletionContinuationOutcomeRecordSnapshot {
  return {
    sessionID: record.handle.sessionID, ordinal: record.handle.ordinal,
    heuristicTerminal: record.heuristicTerminal, heuristicFacts: record.heuristicFacts,
    predictionStatus: record.prediction?.predictionStatus ?? "pending",
    outcomeStatus: record.outcomeStatus, outcomeClosedBy: record.outcomeClosedBy,
    outcomeFacts: record.outcomeFacts, continuationActivity: record.continuationActivity,
    successfulContinuation: record.successfulContinuation, appended: record.appended,
  }
}

export function buildCompletionContinuationObservation(
  record: MutableCompletionContinuationOutcomeRecord,
  recordedAt: string,
): CompletionContinuationObservation {
  const prediction = record.prediction ?? createCompletionContinuationTimeoutPrediction()
  return {
    kind: "observation", schemaVersion: 1, questionVersion: prediction.questionVersion,
    recordedAt, sessionID: record.handle.sessionID, ordinal: record.handle.ordinal, counterEpoch: 0,
    inputDigests: record.current.inputDigests, inputTruncations: record.inputTruncations,
    isContinuationCandidate: record.isContinuationCandidate, probabilities: prediction.probabilities,
    thresholdLabels: prediction.thresholdLabels, confidenceThreshold: record.confidenceThreshold,
    heuristicFacts: record.heuristicFacts, outcomeFacts: record.outcomeFacts,
    outcomeStatus: record.outcomeStatus, outcomeClosedBy: record.outcomeClosedBy,
    predictionStatus: prediction.predictionStatus, notDispatchedReason: prediction.notDispatchedReason,
    unavailableReason: prediction.unavailableReason, resolvedModel: prediction.resolvedModel,
    latencyMs: prediction.latencyMs, invalidAnswerCount: prediction.invalidAnswerCount,
  }
}
