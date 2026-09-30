import { isRecord } from "./answer-validation"
import type { DecisionUnavailableReason } from "./types"

export const INTENT_ROUTING_CONTINUATION_LEXICON = Object.freeze([
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
] as const)

export type IntentRoutingChoiceObservation = {
  readonly choice: string | null
  readonly confidence: number | null
  readonly probabilities: Readonly<Record<string, number>> | null
  readonly valid: boolean
}

export type IntentRoutingNoulObservation = {
  readonly noul: number | null
  readonly valid: boolean
}

export type IntentRoutingAnswers = {
  readonly intent: IntentRoutingChoiceObservation
  readonly category: IntentRoutingChoiceObservation
  readonly subagent: IntentRoutingChoiceObservation
  readonly ambiguous: IntentRoutingNoulObservation
}

export type IntentRoutingRouteClass = "category" | "subagent" | "unscorable_resume" | "unknown"

export type IntentRoutingObservedDelegation = {
  readonly tool: string
  readonly category: string | null
  readonly subagentType: string | null
  readonly requestedSubagentType: string | null
  readonly taskId: string | null
  readonly normalizedCategory: string
  readonly normalizedSubagent: string
  readonly routeClass: IntentRoutingRouteClass
  readonly callID: string | null
}

export type IntentRoutingObservationRecord = {
  readonly kind: "observation"
  readonly schemaVersion: number
  readonly questionVersion: number
  readonly recordedAt: string
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly reuseKey: string
  readonly predictionReused: boolean
  readonly promptHeadChars: string
  readonly promptFullSha256: string
  readonly promptChars: number
  readonly truncatedInput: boolean
  readonly isContinuationCandidate: boolean
  readonly predictionStatus: "filled" | "failed" | "timeout" | "not_dispatched"
  readonly notDispatchedReason: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly answers: IntentRoutingAnswers
  readonly invalidAnswerCount: number
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly observedAreAttempts: true
  readonly distinctCategoryCount: number
  readonly distinctSubagentCount: number
  readonly fanOutBucket: "zero" | "one" | "many"
  readonly correlationStatus: "reliable" | "censored" | "overlap_ambiguous"
  readonly sealedBy: "next_turn" | "session_idle" | "seal_timeout" | "dispose" | "session_deleted"
  readonly counterEpoch: number
}

export type IntentRoutingCounters = {
  readonly turnsSeen: number
  readonly turnsGatedOut: number
  readonly turnsSynthetic: number
  readonly recordsCreated: number
  readonly recordsEvicted: number
  readonly orphanObservations: number
  readonly unscorableResumeCalls: number
  readonly unscorableUnknownCalls: number
  readonly dispatchesDropped: number
  readonly malformedWriteRejections: number
  readonly recordsLostToCap: number
  readonly sinkTruncations: number
}

export type IntentRoutingCounterDelta = {
  readonly kind: "counter_delta"
  readonly schemaVersion: number
  readonly recordedAt: string
  readonly processId: string
  readonly counterEpoch: number
  readonly monotonicSeq: number
  readonly counters: IntentRoutingCounters
}

export type IntentRoutingEntry = IntentRoutingObservationRecord | IntentRoutingCounterDelta

const OBSERVATION_KEYS = [
  "kind", "schemaVersion", "questionVersion", "recordedAt", "sessionID", "turnOrdinal",
  "dedupKey", "reuseKey", "predictionReused", "promptHeadChars", "promptFullSha256",
  "promptChars", "truncatedInput", "isContinuationCandidate", "predictionStatus",
  "notDispatchedReason", "unavailableReason", "resolvedModel", "latencyMs", "answers",
  "invalidAnswerCount", "observed", "observedAreAttempts", "distinctCategoryCount",
  "distinctSubagentCount", "fanOutBucket", "correlationStatus", "sealedBy", "counterEpoch",
] as const
const COUNTER_DELTA_KEYS = [
  "kind", "schemaVersion", "recordedAt", "processId", "counterEpoch", "monotonicSeq", "counters",
] as const
const COUNTER_KEYS = [
  "turnsSeen", "turnsGatedOut", "turnsSynthetic", "recordsCreated", "recordsEvicted",
  "orphanObservations", "unscorableResumeCalls", "unscorableUnknownCalls", "dispatchesDropped",
  "malformedWriteRejections", "recordsLostToCap", "sinkTruncations",
] as const
const OBSERVED_KEYS = [
  "tool", "category", "subagentType", "requestedSubagentType", "taskId", "normalizedCategory",
  "normalizedSubagent", "routeClass", "callID",
] as const
const CHOICE_KEYS = ["choice", "confidence", "probabilities", "valid"] as const
const NOUL_KEYS = ["noul", "valid"] as const
const ANSWER_KEYS = ["intent", "category", "subagent", "ambiguous"] as const
const PREDICTION_STATUSES = ["filled", "failed", "timeout", "not_dispatched"] as const
const ROUTE_CLASSES = ["category", "subagent", "unscorable_resume", "unknown"] as const
const FAN_OUT_BUCKETS = ["zero", "one", "many"] as const
const CORRELATION_STATUSES = ["reliable", "censored", "overlap_ambiguous"] as const
const SEALED_BY_VALUES = ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const
const UNAVAILABLE_REASONS = [
  "disabled", "missing_api_key", "timeout", "transport_error", "api_error", "malformed_response",
  "unscripted", "not_implemented",
] as const satisfies readonly DecisionUnavailableReason[]

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function isStringMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && members.some((member) => member === value)
}

function isUnitNumberMap(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.values(value).every(isUnitNumber)
}

function validateChoiceObservation(value: unknown): value is IntentRoutingChoiceObservation {
  return isRecord(value) && hasExactKeys(value, CHOICE_KEYS) &&
    isNullableString(value.choice) && (value.confidence === null || isUnitNumber(value.confidence)) &&
    (value.probabilities === null || isUnitNumberMap(value.probabilities)) && typeof value.valid === "boolean"
}

function validateNoulObservation(value: unknown): value is IntentRoutingNoulObservation {
  return isRecord(value) && hasExactKeys(value, NOUL_KEYS) &&
    (value.noul === null || isUnitNumber(value.noul)) && typeof value.valid === "boolean"
}

function validateAnswers(value: unknown): value is IntentRoutingAnswers {
  return isRecord(value) && hasExactKeys(value, ANSWER_KEYS) &&
    validateChoiceObservation(value.intent) && validateChoiceObservation(value.category) &&
    validateChoiceObservation(value.subagent) && validateNoulObservation(value.ambiguous)
}

function validateObservedDelegation(value: unknown): value is IntentRoutingObservedDelegation {
  return isRecord(value) && hasExactKeys(value, OBSERVED_KEYS) && typeof value.tool === "string" &&
    isNullableString(value.category) && isNullableString(value.subagentType) &&
    isNullableString(value.requestedSubagentType) && isNullableString(value.taskId) &&
    typeof value.normalizedCategory === "string" && typeof value.normalizedSubagent === "string" &&
    isStringMember(value.routeClass, ROUTE_CLASSES) &&
    isNullableString(value.callID)
}

function validateCounters(value: unknown): value is IntentRoutingCounters {
  return isRecord(value) && hasExactKeys(value, COUNTER_KEYS) &&
    COUNTER_KEYS.every((key) => isNonnegativeInteger(value[key]))
}

export function isIntentRoutingContinuationCandidate(normalizedPrompt: string): boolean {
  const candidate = normalizedPrompt.trim().replace(/[\p{P}]+$/gu, "").trim()
  const tokenCount = candidate === "" ? 0 : candidate.split(/\s+/u).length
  return tokenCount <= 4 && INTENT_ROUTING_CONTINUATION_LEXICON.some((term) => term === candidate)
}

export function validateIntentRoutingObservationRecord(
  value: unknown,
): value is IntentRoutingObservationRecord {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_KEYS)) return false
  return value.kind === "observation" && isNonnegativeInteger(value.schemaVersion) &&
    isNonnegativeInteger(value.questionVersion) && typeof value.recordedAt === "string" &&
    typeof value.sessionID === "string" && isNonnegativeInteger(value.turnOrdinal) &&
    typeof value.dedupKey === "string" && typeof value.reuseKey === "string" &&
    typeof value.predictionReused === "boolean" && typeof value.promptHeadChars === "string" &&
    typeof value.promptFullSha256 === "string" && isNonnegativeInteger(value.promptChars) &&
    typeof value.truncatedInput === "boolean" && typeof value.isContinuationCandidate === "boolean" &&
    isStringMember(value.predictionStatus, PREDICTION_STATUSES) &&
    isNullableString(value.notDispatchedReason) &&
    (value.unavailableReason === null || isStringMember(value.unavailableReason, UNAVAILABLE_REASONS)) &&
    isNullableString(value.resolvedModel) && typeof value.latencyMs === "number" &&
    Number.isFinite(value.latencyMs) && value.latencyMs >= 0 && validateAnswers(value.answers) &&
    isNonnegativeInteger(value.invalidAnswerCount) && Array.isArray(value.observed) &&
    value.observed.every(validateObservedDelegation) && value.observedAreAttempts === true &&
    isNonnegativeInteger(value.distinctCategoryCount) && isNonnegativeInteger(value.distinctSubagentCount) &&
    isStringMember(value.fanOutBucket, FAN_OUT_BUCKETS) &&
    isStringMember(value.correlationStatus, CORRELATION_STATUSES) &&
    isStringMember(value.sealedBy, SEALED_BY_VALUES) &&
    isNonnegativeInteger(value.counterEpoch)
}

export function validateIntentRoutingCounterDelta(value: unknown): value is IntentRoutingCounterDelta {
  return isRecord(value) && hasExactKeys(value, COUNTER_DELTA_KEYS) && value.kind === "counter_delta" &&
    isNonnegativeInteger(value.schemaVersion) && typeof value.recordedAt === "string" &&
    typeof value.processId === "string" && isNonnegativeInteger(value.counterEpoch) &&
    isNonnegativeInteger(value.monotonicSeq) && validateCounters(value.counters)
}

export function validateIntentRoutingEntry(value: unknown): value is IntentRoutingEntry {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "observation": return validateIntentRoutingObservationRecord(value)
    case "counter_delta": return validateIntentRoutingCounterDelta(value)
    default: return false
  }
}

export function selectLatestIntentRoutingCountersByProcess(
  entries: readonly IntentRoutingEntry[],
): ReadonlyMap<string, IntentRoutingCounterDelta> {
  const latest = new Map<string, IntentRoutingCounterDelta>()
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
