import { isRecord, validateAnswer } from "./answer-validation"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import type { IntentRoutingChoiceAnswer, IntentRoutingNoulAnswer } from "./intent-routing-record"
import type {
  ChoiceQuestion,
  DecisionBackend,
  DecisionUnavailableReason,
  NoulQuestion,
} from "./types"

export type IntentRoutingDecisionLabel = "would_apply" | "would_fall_through"

type ValidDecisionChoiceAnswer = IntentRoutingChoiceAnswer & {
  readonly valid: true
  readonly label: IntentRoutingDecisionLabel
}

type InvalidDecisionChoiceAnswer = {
  readonly choice: unknown
  readonly confidence: unknown
  readonly probabilities: unknown
  readonly valid: false
  readonly label: IntentRoutingDecisionLabel | null
}

export type IntentRoutingDecisionChoiceAnswer =
  | ValidDecisionChoiceAnswer
  | InvalidDecisionChoiceAnswer

type ValidDecisionNoulAnswer = IntentRoutingNoulAnswer & { readonly valid: true }
type InvalidDecisionNoulAnswer = { readonly noul: unknown; readonly valid: false }

export type IntentRoutingDecisionAnswers = {
  readonly intent: IntentRoutingDecisionChoiceAnswer
  readonly category: IntentRoutingDecisionChoiceAnswer
  readonly subagent: IntentRoutingDecisionChoiceAnswer
  readonly ambiguous: ValidDecisionNoulAnswer | InvalidDecisionNoulAnswer
}

export type IntentRoutingDecisionResult = {
  readonly predictionStatus: "filled" | "failed"
  readonly truncatedInput: boolean
  readonly answers: IntentRoutingDecisionAnswers | null
  readonly invalidAnswerCount: number
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly threshold: number
  readonly questionVersion: number
}

function decisionLabel(confidence: unknown, threshold: number): IntentRoutingDecisionLabel | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null
  return confidence >= threshold ? "would_apply" : "would_fall_through"
}

function rawAnswerField(raw: unknown, field: string): unknown {
  return isRecord(raw) ? raw[field] : undefined
}

function recordChoiceAnswer(
  question: ChoiceQuestion,
  raw: unknown,
  threshold: number,
): IntentRoutingDecisionChoiceAnswer {
  if (validateAnswer(question, raw)) {
    return {
      choice: raw.choice,
      confidence: raw.confidence,
      probabilities: raw.probabilities,
      valid: true,
      label: raw.confidence >= threshold ? "would_apply" : "would_fall_through",
    }
  }

  const confidence = rawAnswerField(raw, "confidence")
  return {
    choice: rawAnswerField(raw, "choice"),
    confidence,
    probabilities: rawAnswerField(raw, "probabilities"),
    valid: false,
    label: decisionLabel(confidence, threshold),
  }
}

function recordNoulAnswer(
  question: NoulQuestion,
  raw: unknown,
): ValidDecisionNoulAnswer | InvalidDecisionNoulAnswer {
  if (validateAnswer(question, raw)) return { noul: raw.noul, valid: true }
  return { noul: rawAnswerField(raw, "noul"), valid: false }
}

function failedDecision(
  truncatedInput: boolean,
  threshold: number,
  unavailableReason: DecisionUnavailableReason,
  latencyMs: number | null,
): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed",
    truncatedInput,
    answers: null,
    invalidAnswerCount: 0,
    unavailableReason,
    resolvedModel: null,
    latencyMs,
    threshold,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
  }
}

export async function decideIntentRouting(args: {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}): Promise<IntentRoutingDecisionResult> {
  const promptText = args.input.promptText.slice(0, args.maxPromptChars)
  const truncatedInput = promptText.length < args.input.promptText.length
  if (args.backend.kind === "disabled") {
    return failedDecision(truncatedInput, args.confidenceThreshold, "disabled", null)
  }

  try {
    const questions = buildIntentRoutingQuestions(args.vocab)
    const outcome = await args.backend.decide({
      state: { promptText, truncatedInput },
      questions,
      model: args.model,
    })
    if (outcome.status === "unavailable") {
      return failedDecision(truncatedInput, args.confidenceThreshold, outcome.reason, outcome.latencyMs)
    }

    const rawAnswers: unknown = outcome.answers
    const answerRecord = isRecord(rawAnswers) ? rawAnswers : {}
    const answers: IntentRoutingDecisionAnswers = {
      intent: recordChoiceAnswer(questions.intent, answerRecord.intent, args.confidenceThreshold),
      category: recordChoiceAnswer(questions.category, answerRecord.category, args.confidenceThreshold),
      subagent: recordChoiceAnswer(questions.subagent, answerRecord.subagent, args.confidenceThreshold),
      ambiguous: recordNoulAnswer(questions.ambiguous, answerRecord.ambiguous),
    }

    return {
      predictionStatus: "filled",
      truncatedInput,
      answers,
      invalidAnswerCount: Object.values(answers).filter((answer) => !answer.valid).length,
      unavailableReason: null,
      resolvedModel: outcome.model,
      latencyMs: outcome.latencyMs,
      threshold: args.confidenceThreshold,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    }
  } catch {
    return failedDecision(truncatedInput, args.confidenceThreshold, "transport_error", null)
  }
}
