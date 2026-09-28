import { isRecord } from "./answer-validation"
import type {
  IntentRoutingAnswers,
  IntentRoutingChoiceAnswer,
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingEntry,
  IntentRoutingNoulAnswer,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "./intent-routing-record"

type FieldValidator = (value: unknown) => boolean

const unavailableReasons = new Set<string>([
  "disabled",
  "missing_api_key",
  "timeout",
  "transport_error",
  "api_error",
  "malformed_response",
  "unscripted",
  "not_implemented",
])
const predictionStatuses = new Set<string>(["filled", "failed", "timeout", "not_dispatched"])
const routeClasses = new Set<string>(["category", "subagent", "unscorable_resume", "unknown"])
const fanOutBuckets = new Set<string>(["zero", "one", "many"])
const correlationStatuses = new Set<string>(["reliable", "censored", "overlap_ambiguous"])
const sealedByValues = new Set<string>([
  "next_turn",
  "session_idle",
  "seal_timeout",
  "dispose",
  "session_deleted",
])

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isProbability(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && value <= 1
}

function isMember(value: unknown, values: ReadonlySet<string>): boolean {
  return isString(value) && values.has(value)
}

function hasExactShape(value: unknown, fields: Readonly<Record<string, FieldValidator>>): boolean {
  if (!isRecord(value)) {
    return false
  }
  const expectedKeys = Object.keys(fields)
  if (Object.keys(value).length !== expectedKeys.length) {
    return false
  }
  return expectedKeys.every((key) => {
    const validate = fields[key]
    return validate !== undefined && validate(value[key])
  })
}

function validateProbabilities(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isProbability)
}

const choiceAnswerFields = {
  choice: isString,
  confidence: isProbability,
  probabilities: validateProbabilities,
  valid: isBoolean,
} satisfies Readonly<Record<keyof IntentRoutingChoiceAnswer, FieldValidator>>

function validateChoiceAnswer(value: unknown): value is IntentRoutingChoiceAnswer {
  return hasExactShape(value, choiceAnswerFields)
}

const noulAnswerFields = {
  noul: isProbability,
  valid: isBoolean,
} satisfies Readonly<Record<keyof IntentRoutingNoulAnswer, FieldValidator>>

function validateNoulAnswer(value: unknown): value is IntentRoutingNoulAnswer {
  return hasExactShape(value, noulAnswerFields)
}

const answersFields = {
  intent: validateChoiceAnswer,
  category: validateChoiceAnswer,
  subagent: validateChoiceAnswer,
  ambiguous: validateNoulAnswer,
} satisfies Readonly<Record<keyof IntentRoutingAnswers, FieldValidator>>

function validateAnswers(value: unknown): value is IntentRoutingAnswers {
  return hasExactShape(value, answersFields)
}

const observedDelegationFields = {
  tool: isString,
  category: isNullableString,
  subagentType: isNullableString,
  requestedSubagentType: isNullableString,
  taskId: isNullableString,
  normalizedCategory: isString,
  normalizedSubagent: isString,
  routeClass: (value: unknown) => isMember(value, routeClasses),
  callID: isString,
} satisfies Readonly<Record<keyof IntentRoutingObservedDelegation, FieldValidator>>

function validateObservedDelegation(value: unknown): value is IntentRoutingObservedDelegation {
  return hasExactShape(value, observedDelegationFields)
}

const observationFields = {
  kind: (value: unknown) => value === "observation",
  schemaVersion: isNonNegativeInteger,
  questionVersion: isNonNegativeInteger,
  recordedAt: isString,
  sessionID: isString,
  turnOrdinal: isNonNegativeInteger,
  dedupKey: isString,
  reuseKey: isString,
  predictionReused: isBoolean,
  promptHeadChars: isString,
  promptFullSha256: (value: unknown) => isString(value) && /^[a-f\d]{64}$/.test(value),
  promptChars: isNonNegativeInteger,
  truncatedInput: isBoolean,
  isContinuationCandidate: isBoolean,
  predictionStatus: (value: unknown) => isMember(value, predictionStatuses),
  notDispatchedReason: isNullableString,
  unavailableReason: (value: unknown) => value === null || isMember(value, unavailableReasons),
  resolvedModel: isNullableString,
  latencyMs: isNonNegativeFiniteNumber,
  answers: (value: unknown) => value === null || validateAnswers(value),
  invalidAnswerCount: isNonNegativeInteger,
  observed: (value: unknown) => Array.isArray(value) && value.every(validateObservedDelegation),
  observedAreAttempts: (value: unknown) => value === true,
  distinctCategoryCount: isNonNegativeInteger,
  distinctSubagentCount: isNonNegativeInteger,
  fanOutBucket: (value: unknown) => isMember(value, fanOutBuckets),
  correlationStatus: (value: unknown) => isMember(value, correlationStatuses),
  sealedBy: (value: unknown) => isMember(value, sealedByValues),
  counterEpoch: isNonNegativeInteger,
} satisfies Readonly<Record<keyof IntentRoutingObservationRecord, FieldValidator>>

export function validateIntentRoutingObservationRecord(
  value: unknown,
): value is IntentRoutingObservationRecord {
  return hasExactShape(value, observationFields)
}

const counterFields = {
  turnsSeen: isNonNegativeInteger,
  turnsGatedOut: isNonNegativeInteger,
  turnsSynthetic: isNonNegativeInteger,
  recordsCreated: isNonNegativeInteger,
  recordsInFlight: isNonNegativeInteger,
  recordsEvicted: isNonNegativeInteger,
  orphanObservations: isNonNegativeInteger,
  unscorableResumeCalls: isNonNegativeInteger,
  unscorableUnknownCalls: isNonNegativeInteger,
  dispatchesDropped: isNonNegativeInteger,
  malformedWriteRejections: isNonNegativeInteger,
  recordsLostToCap: isNonNegativeInteger,
  sinkTruncations: isNonNegativeInteger,
} satisfies Readonly<Record<keyof IntentRoutingCounters, FieldValidator>>

function validateCounters(value: unknown): value is IntentRoutingCounters {
  return hasExactShape(value, counterFields)
}

const counterDeltaFields = {
  kind: (value: unknown) => value === "counter_delta",
  schemaVersion: isNonNegativeInteger,
  recordedAt: isString,
  processId: isString,
  counterEpoch: isNonNegativeInteger,
  monotonicSeq: isNonNegativeInteger,
  counters: validateCounters,
} satisfies Readonly<Record<keyof IntentRoutingCounterDelta, FieldValidator>>

export function validateIntentRoutingCounterDelta(value: unknown): value is IntentRoutingCounterDelta {
  return hasExactShape(value, counterDeltaFields)
}

export function validateIntentRoutingEntry(value: unknown): value is IntentRoutingEntry {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case "observation":
      return validateIntentRoutingObservationRecord(value)
    case "counter_delta":
      return validateIntentRoutingCounterDelta(value)
    default:
      return false
  }
}
