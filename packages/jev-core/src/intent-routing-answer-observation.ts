import { isRecord, validateAnswer } from "./answer-validation"
import type {
  IntentRoutingChoiceObservation,
  IntentRoutingNoulObservation,
} from "./intent-routing-record"
import type { ChoiceQuestion, NoulQuestion } from "./types"

export type IntentRoutingChoiceLabel = "would_apply" | "would_fall_through"

export type IntentRoutingDecisionChoice = IntentRoutingChoiceObservation & {
  readonly label: IntentRoutingChoiceLabel
}

export type IntentRoutingDecisionAnswers = {
  readonly intent: IntentRoutingDecisionChoice
  readonly category: IntentRoutingDecisionChoice
  readonly subagent: IntentRoutingDecisionChoice
  readonly ambiguous: IntentRoutingNoulObservation
}

function isNumberMap(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "number")
}

export function readChoiceDecision(
  question: ChoiceQuestion,
  raw: unknown,
  confidenceThreshold: number,
): IntentRoutingDecisionChoice {
  const valid = validateAnswer(question, raw)
  const choice = isRecord(raw) && typeof raw.choice === "string" ? raw.choice : null
  const confidence = isRecord(raw) && typeof raw.confidence === "number" ? raw.confidence : null
  const probabilities = isRecord(raw) && isNumberMap(raw.probabilities)
    ? raw.probabilities
    : null
  return {
    choice,
    confidence,
    probabilities,
    valid,
    label: confidence !== null && confidence >= confidenceThreshold
      ? "would_apply"
      : "would_fall_through",
  }
}

export function readNoulDecision(
  question: NoulQuestion,
  raw: unknown,
): IntentRoutingNoulObservation {
  const record = isRecord(raw) ? raw : undefined
  return {
    noul: record !== undefined && typeof record.noul === "number" ? record.noul : null,
    valid: validateAnswer(question, raw) &&
      record !== undefined && !Object.hasOwn(record, "confidence"),
  }
}

export function emptyDecisionAnswers(): IntentRoutingDecisionAnswers {
  const choice = {
    choice: null,
    confidence: null,
    probabilities: null,
    valid: false,
    label: "would_fall_through",
  } as const
  return {
    intent: choice,
    category: choice,
    subagent: choice,
    ambiguous: { noul: null, valid: false },
  }
}
