import { isRecord } from "./answer-validation"
import {
  COMPLETION_CONTINUATION_CENSORED_CLOSURES,
  COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES,
  COMPLETION_CONTINUATION_PREDICTION_STATUSES,
  COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS,
  COMPLETION_CONTINUATION_THRESHOLD_LABELS,
  type CompletionContinuationCounterDelta,
  type CompletionContinuationCounters,
  type CompletionContinuationEntry,
  type CompletionContinuationHeuristicFacts,
  type CompletionContinuationInputDigests,
  type CompletionContinuationInputTruncations,
  type CompletionContinuationObservation,
  type CompletionContinuationOutcomeFacts,
  type CompletionContinuationProbabilities,
  type CompletionContinuationThresholdLabels,
} from "./completion-continuation-record-types"
import type { DecisionUnavailableReason } from "./types"

const OBSERVATION_KEYS = [
  "kind", "schemaVersion", "questionVersion", "recordedAt", "sessionID", "ordinal",
  "counterEpoch", "inputDigests", "inputTruncations", "isContinuationCandidate", "probabilities",
  "thresholdLabels", "confidenceThreshold", "heuristicFacts", "outcomeFacts", "outcomeStatus",
  "outcomeClosedBy", "predictionStatus", "notDispatchedReason", "unavailableReason", "resolvedModel",
  "latencyMs", "invalidAnswerCount",
] as const
const INPUT_DIGEST_KEYS = ["todoStatus", "transcript", "diff", "boulder"] as const
const INPUT_TRUNCATION_KEYS = [
  "todoItems", "todoContent", "transcriptMessages", "transcriptContent", "diffPaths", "diffContent",
  "boulderContent", "state",
] as const
const QUESTION_KEYS = ["actuallyComplete", "progressing", "stuck"] as const
const HEURISTIC_FACT_KEYS = [
  "gauntletOutcome", "todoComplete", "promiseComplete", "todoProgress", "stagnationStop",
] as const
const COUNTER_DELTA_KEYS = [
  "kind", "schemaVersion", "recordedAt", "processId", "counterEpoch", "monotonicSeq", "counters",
] as const
const COUNTER_KEYS = [
  "starts", "preInputSkips", "dispatchesDropped", "recordsEvicted", "censoredWindows",
  "malformedLines", "malformedWriteRejections", "recordsLostToCap", "sinkTruncations",
] as const
const OUTCOME_STATUSES = ["pending", "observed", "censored"] as const
const NOT_DISPATCHED_REASONS = ["max_inflight"] as const
const UNAVAILABLE_REASONS = [
  "disabled", "missing_api_key", "timeout", "transport_error", "api_error", "malformed_response",
  "unscripted", "not_implemented",
] as const satisfies readonly DecisionUnavailableReason[]

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && members.some((member) => member === value)
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean"
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function validateInputDigests(value: unknown): value is CompletionContinuationInputDigests {
  return isRecord(value) && hasExactKeys(value, INPUT_DIGEST_KEYS) &&
    typeof value.todoStatus === "string" && isNullableString(value.transcript) &&
    isNullableString(value.diff) && isNullableString(value.boulder)
}

function validateInputTruncations(value: unknown): value is CompletionContinuationInputTruncations {
  return isRecord(value) && hasExactKeys(value, INPUT_TRUNCATION_KEYS) &&
    INPUT_TRUNCATION_KEYS.every((key) => typeof value[key] === "boolean")
}

function validateProbabilities(value: unknown): value is CompletionContinuationProbabilities {
  return isRecord(value) && hasExactKeys(value, QUESTION_KEYS) &&
    QUESTION_KEYS.every((key) => value[key] === null || isUnitNumber(value[key]))
}

function validateThresholdLabels(value: unknown): value is CompletionContinuationThresholdLabels {
  return isRecord(value) && hasExactKeys(value, QUESTION_KEYS) &&
    QUESTION_KEYS.every((key) => isMember(value[key], COMPLETION_CONTINUATION_THRESHOLD_LABELS))
}

function validateHeuristicFacts(value: unknown): value is CompletionContinuationHeuristicFacts {
  return isRecord(value) && hasExactKeys(value, HEURISTIC_FACT_KEYS) &&
    isMember(value.gauntletOutcome, COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES) &&
    isNullableBoolean(value.todoComplete) && isNullableBoolean(value.promiseComplete) &&
    isNullableBoolean(value.todoProgress) && isNullableBoolean(value.stagnationStop)
}

function isOutcomeTruth(value: unknown): value is boolean | "unknown" {
  return typeof value === "boolean" || value === "unknown"
}

function validateOutcomeFacts(value: unknown): value is CompletionContinuationOutcomeFacts {
  return isRecord(value) && hasExactKeys(value, QUESTION_KEYS) &&
    QUESTION_KEYS.every((key) => isOutcomeTruth(value[key]))
}

function hasOutcomeFacts(
  facts: CompletionContinuationOutcomeFacts,
  actuallyComplete: boolean | "unknown",
  progressing: boolean | "unknown",
  stuck: boolean | "unknown",
): boolean {
  return facts.actuallyComplete === actuallyComplete && facts.progressing === progressing && facts.stuck === stuck
}

function validateOutcomeState(value: Record<string, unknown>, facts: CompletionContinuationOutcomeFacts): boolean {
  if (!isMember(value.outcomeStatus, OUTCOME_STATUSES)) return false
  switch (value.outcomeStatus) {
    case "pending":
      return value.outcomeClosedBy === null && hasOutcomeFacts(facts, "unknown", "unknown", "unknown")
    case "observed":
      if (value.outcomeClosedBy === "tracked_work_complete") return hasOutcomeFacts(facts, true, true, false)
      if (value.outcomeClosedBy === "tracked_work_progressed") return hasOutcomeFacts(facts, false, true, false)
      return value.outcomeClosedBy === "unchanged_next_idle" && hasOutcomeFacts(facts, false, false, true)
    case "censored":
      return isMember(value.outcomeClosedBy, COMPLETION_CONTINUATION_CENSORED_CLOSURES) &&
        hasOutcomeFacts(facts, "unknown", "unknown", "unknown")
  }
}

function predictionsMatchLabels(
  probabilities: CompletionContinuationProbabilities,
  labels: CompletionContinuationThresholdLabels,
): boolean {
  return QUESTION_KEYS.every((key) =>
    (probabilities[key] === null) === (labels[key] === "unavailable"))
}

function validatePredictionState(value: Record<string, unknown>, probabilities: CompletionContinuationProbabilities): boolean {
  if (!isMember(value.predictionStatus, COMPLETION_CONTINUATION_PREDICTION_STATUSES)) return false
  const unavailableReason = value.unavailableReason
  const unavailableIsValid = unavailableReason === null || isMember(unavailableReason, UNAVAILABLE_REASONS)
  if (!unavailableIsValid || !isNonnegativeInteger(value.invalidAnswerCount)) return false
  switch (value.predictionStatus) {
    case "filled":
      return QUESTION_KEYS.every((key) => probabilities[key] !== null) &&
        value.invalidAnswerCount === 0 && value.notDispatchedReason === null && unavailableReason === null
    case "failed":
      return value.notDispatchedReason === null && unavailableReason !== null && unavailableReason !== "timeout"
    case "timeout":
      return QUESTION_KEYS.every((key) => probabilities[key] === null) &&
        value.notDispatchedReason === null && unavailableReason === "timeout"
    case "not_dispatched":
      return QUESTION_KEYS.every((key) => probabilities[key] === null) &&
        isMember(value.notDispatchedReason, NOT_DISPATCHED_REASONS) && unavailableReason === null
  }
}

function validatePreInputSkips(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS) &&
    COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS.every((key) => isNonnegativeInteger(value[key]))
}

function validateCounters(value: unknown): value is CompletionContinuationCounters {
  return isRecord(value) && hasExactKeys(value, COUNTER_KEYS) && validatePreInputSkips(value.preInputSkips) &&
    COUNTER_KEYS.filter((key) => key !== "preInputSkips").every((key) => isNonnegativeInteger(value[key]))
}

export function validateCompletionContinuationObservation(
  value: unknown,
): value is CompletionContinuationObservation {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_KEYS)) return false
  if (!validateProbabilities(value.probabilities) || !validateThresholdLabels(value.thresholdLabels)) return false
  if (!predictionsMatchLabels(value.probabilities, value.thresholdLabels) || !validateOutcomeFacts(value.outcomeFacts)) return false
  return value.kind === "observation" && isNonnegativeInteger(value.schemaVersion) &&
    isNonnegativeInteger(value.questionVersion) && typeof value.recordedAt === "string" &&
    typeof value.sessionID === "string" && isNonnegativeInteger(value.ordinal) &&
    isNonnegativeInteger(value.counterEpoch) && validateInputDigests(value.inputDigests) &&
    validateInputTruncations(value.inputTruncations) && typeof value.isContinuationCandidate === "boolean" &&
    isUnitNumber(value.confidenceThreshold) && validateHeuristicFacts(value.heuristicFacts) &&
    validateOutcomeState(value, value.outcomeFacts) && validatePredictionState(value, value.probabilities) &&
    isNullableString(value.resolvedModel) && typeof value.latencyMs === "number" &&
    Number.isFinite(value.latencyMs) && value.latencyMs >= 0
}

export function validateCompletionContinuationCounterDelta(
  value: unknown,
): value is CompletionContinuationCounterDelta {
  return isRecord(value) && hasExactKeys(value, COUNTER_DELTA_KEYS) && value.kind === "counter_delta" &&
    isNonnegativeInteger(value.schemaVersion) && typeof value.recordedAt === "string" &&
    typeof value.processId === "string" && isNonnegativeInteger(value.counterEpoch) &&
    isNonnegativeInteger(value.monotonicSeq) && validateCounters(value.counters)
}

export function validateCompletionContinuationEntry(value: unknown): value is CompletionContinuationEntry {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "observation": return validateCompletionContinuationObservation(value)
    case "counter_delta": return validateCompletionContinuationCounterDelta(value)
    default: return false
  }
}

export function selectLatestCompletionContinuationCountersByProcess(
  entries: readonly CompletionContinuationEntry[],
): ReadonlyMap<string, CompletionContinuationCounterDelta> {
  const latest = new Map<string, CompletionContinuationCounterDelta>()
  for (const entry of entries) {
    if (entry.kind !== "counter_delta") continue
    const previous = latest.get(entry.processId)
    if (previous === undefined || entry.counterEpoch > previous.counterEpoch ||
      (entry.counterEpoch === previous.counterEpoch && entry.monotonicSeq > previous.monotonicSeq)) {
      latest.set(entry.processId, entry)
    }
  }
  return latest
}
