import { isRecord, validateAnswer } from "./answer-validation"
import {
  INTENT_ROUTING_PROMPT_HEAD_MAX_CHARS,
  INTENT_ROUTING_SCHEMA_VERSION,
  isIntentRoutingContinuationCandidate,
  type IntentRoutingChoiceAnswer,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
  type IntentRoutingNoulAnswer,
  type IntentRoutingObservationRecord,
  type IntentRoutingObservedDelegation,
} from "./intent-routing-record"
import type { DecisionUnavailableReason } from "./types"

const observationKeys = [
  "kind", "schemaVersion", "questionVersion", "recordedAt", "sessionID", "turnOrdinal",
  "dedupKey", "reuseKey", "predictionReused", "promptHeadChars", "promptFullSha256",
  "promptChars", "truncatedInput", "isContinuationCandidate", "predictionStatus",
  "notDispatchedReason", "unavailableReason", "resolvedModel", "latencyMs", "answers",
  "invalidAnswerCount", "observed", "observedAreAttempts", "distinctCategoryCount",
  "distinctSubagentCount", "fanOutBucket", "correlationStatus", "sealedBy", "counterEpoch",
] as const
const observedKeys = [
  "tool", "category", "subagentType", "requestedSubagentType", "taskId", "normalizedCategory",
  "normalizedSubagent", "routeClass", "callID",
] as const
const counterDeltaKeys = [
  "kind", "schemaVersion", "recordedAt", "processId", "counterEpoch", "monotonicSeq", "counters",
] as const
const counterKeys = [
  "turnsSeen", "turnsGatedOut", "turnsSynthetic", "recordsCreated", "recordsEvicted",
  "orphanObservations", "unscorableResumeCalls", "unscorableUnknownCalls", "dispatchesDropped",
  "malformedWriteRejections", "recordsLostToCap", "sinkTruncations",
] as const
const unavailableReasons = new Set<DecisionUnavailableReason>([
  "disabled", "missing_api_key", "timeout", "transport_error", "api_error", "malformed_response",
  "unscripted", "not_implemented",
])

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function isOneOf(value: unknown, options: readonly string[]): value is string {
  return typeof value === "string" && options.includes(value)
}

function validateProbabilities(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.values(value).every(
    (probability) => typeof probability === "number" && Number.isFinite(probability),
  )
}

function validateChoiceAnswer(value: unknown): value is IntentRoutingChoiceAnswer {
  if (!isRecord(value) || !hasExactKeys(value, ["choice", "confidence", "probabilities", "valid"])) {
    return false
  }
  if (
    typeof value.choice !== "string" || typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) || !validateProbabilities(value.probabilities) ||
    typeof value.valid !== "boolean"
  ) return false
  if (!value.valid) return true

  const criteria: Record<string, null> = {}
  for (const key of Object.keys(value.probabilities)) criteria[key] = null
  return validateAnswer(
    { type: "choice", instructions: "Validate an intent-routing record", criteria },
    { type: "choice", choice: value.choice, confidence: value.confidence, probabilities: value.probabilities },
  )
}

function validateNoulAnswer(value: unknown): value is IntentRoutingNoulAnswer {
  if (!isRecord(value) || !hasExactKeys(value, ["noul", "valid"])) return false
  if (typeof value.noul !== "number" || !Number.isFinite(value.noul) || typeof value.valid !== "boolean") {
    return false
  }
  return !value.valid || validateAnswer(
    { type: "noul", instructions: "Validate an intent-routing record" },
    { type: "noul", noul: value.noul },
  )
}

function validateAnswers(value: unknown): boolean {
  return value === null || (
    isRecord(value) && hasExactKeys(value, ["intent", "category", "subagent", "ambiguous"]) &&
    validateChoiceAnswer(value.intent) && validateChoiceAnswer(value.category) &&
    validateChoiceAnswer(value.subagent) && validateNoulAnswer(value.ambiguous)
  )
}

function validateObservedDelegation(value: unknown): value is IntentRoutingObservedDelegation {
  return isRecord(value) && hasExactKeys(value, observedKeys) &&
    isOneOf(value.tool, ["task", "call_omo_agent"]) && isNullableString(value.category) &&
    isNullableString(value.subagentType) && isNullableString(value.requestedSubagentType) &&
    isNullableString(value.taskId) && isNonEmptyString(value.normalizedCategory) &&
    isNonEmptyString(value.normalizedSubagent) &&
    isOneOf(value.routeClass, ["none", "category", "subagent", "unscorable_resume", "unknown"]) &&
    isNonEmptyString(value.callID)
}

function validateUnavailableReason(value: unknown): value is DecisionUnavailableReason | null {
  return value === null || (typeof value === "string" && unavailableReasons.has(value as DecisionUnavailableReason))
}

export function validateIntentRoutingObservationRecord(
  value: unknown,
): value is IntentRoutingObservationRecord {
  return isRecord(value) && hasExactKeys(value, observationKeys) && value.kind === "observation" &&
    value.schemaVersion === INTENT_ROUTING_SCHEMA_VERSION && isNonNegativeInteger(value.questionVersion) &&
    isNonEmptyString(value.recordedAt) && isNonEmptyString(value.sessionID) &&
    isNonNegativeInteger(value.turnOrdinal) && isNonEmptyString(value.dedupKey) &&
    isNonEmptyString(value.reuseKey) && typeof value.predictionReused === "boolean" &&
    typeof value.promptHeadChars === "string" &&
    value.promptHeadChars.length <= INTENT_ROUTING_PROMPT_HEAD_MAX_CHARS &&
    typeof value.promptFullSha256 === "string" && /^[a-f\d]{64}$/u.test(value.promptFullSha256) &&
    isNonNegativeInteger(value.promptChars) && typeof value.truncatedInput === "boolean" &&
    value.isContinuationCandidate === isIntentRoutingContinuationCandidate(value.promptHeadChars) &&
    isOneOf(value.predictionStatus, ["filled", "failed", "timeout", "not_dispatched"]) &&
    isNullableString(value.notDispatchedReason) && validateUnavailableReason(value.unavailableReason) &&
    isNullableString(value.resolvedModel) && value.resolvedModel !== "jev-latest" &&
    isNonNegativeNumberOrNull(value.latencyMs) && validateAnswers(value.answers) &&
    isNonNegativeInteger(value.invalidAnswerCount) && Array.isArray(value.observed) &&
    value.observed.every(validateObservedDelegation) && value.observedAreAttempts === true &&
    isNonNegativeInteger(value.distinctCategoryCount) && isNonNegativeInteger(value.distinctSubagentCount) &&
    isOneOf(value.fanOutBucket, ["zero", "one", "many"]) &&
    isOneOf(value.correlationStatus, ["reliable", "censored", "overlap_ambiguous"]) &&
    isOneOf(value.sealedBy, ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"]) &&
    isNonNegativeInteger(value.counterEpoch)
}

function validateCounters(value: unknown): value is IntentRoutingCounters {
  return isRecord(value) && hasExactKeys(value, counterKeys) &&
    counterKeys.every((key) => isNonNegativeInteger(value[key]))
}

export function validateIntentRoutingCounterDelta(value: unknown): value is IntentRoutingCounterDelta {
  return isRecord(value) && hasExactKeys(value, counterDeltaKeys) && value.kind === "counter_delta" &&
    value.schemaVersion === INTENT_ROUTING_SCHEMA_VERSION && isNonEmptyString(value.recordedAt) &&
    isNonEmptyString(value.processId) && isNonNegativeInteger(value.counterEpoch) &&
    isNonNegativeInteger(value.monotonicSeq) && validateCounters(value.counters)
}

export function validateIntentRoutingEntry(value: unknown): value is IntentRoutingEntry {
  return validateIntentRoutingObservationRecord(value) || validateIntentRoutingCounterDelta(value)
}
