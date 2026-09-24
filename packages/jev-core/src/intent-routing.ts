import { isRecord, validateAnswer } from "./answer-validation"
import type { IntentRoutingAnswers, IntentRoutingChoiceAnswer } from "./intent-routing-record"
import type { ChoiceQuestion, DecisionBackend, DecisionUnavailableReason, Questions } from "./types"
export const INTENT_ROUTING_QUESTION_VERSION = 1
export type IntentRoutingVocabularyOption = {
  readonly name: string
  readonly description: string
}
export type IntentRoutingVocabulary = {
  readonly categories: readonly IntentRoutingVocabularyOption[]
  readonly subagents: readonly IntentRoutingVocabularyOption[]
  readonly intents: readonly IntentRoutingVocabularyOption[]
}
export type IntentRoutingInput = { readonly promptText: string }
export type IntentRoutingThresholdLabel = "would_apply" | "would_fall_through"
export type IntentRoutingLabels = Readonly<Record<"intent" | "category" | "subagent", IntentRoutingThresholdLabel>>
export type IntentRoutingDecisionResult = {
  readonly predictionStatus: "filled" | "failed"
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly truncatedInput: boolean
  readonly answers: IntentRoutingAnswers | null
  readonly labels: IntentRoutingLabels | null
  readonly invalidAnswerCount: number
  readonly questionVersion: number
}
export class IntentRoutingVocabularyError extends TypeError {
  override readonly name = "IntentRoutingVocabularyError"
}
const MAX_CHOICE_OPTIONS_EXCLUSIVE = 255

function buildChoiceCriteria(
  vocabularyName: keyof IntentRoutingVocabulary,
  options: readonly IntentRoutingVocabularyOption[],
  noneDescription?: string,
): Readonly<Record<string, string>> {
  if (options.length === 0) {
    throw new IntentRoutingVocabularyError(
      `Intent-routing ${vocabularyName} vocabulary must contain at least one option`,
    )
  }

  const labels = new Set<string>()
  for (const option of options) {
    if (option.name.trim().length === 0) {
      throw new IntentRoutingVocabularyError(
        `Intent-routing ${vocabularyName} vocabulary contains an empty option label`,
      )
    }
    if (labels.has(option.name) || (option.name === "none" && noneDescription !== undefined)) {
      throw new IntentRoutingVocabularyError(
        `Intent-routing ${vocabularyName} vocabulary contains duplicate label: ${option.name}`,
      )
    }
    labels.add(option.name)
  }

  const optionCount = labels.size + (noneDescription === undefined ? 0 : 1)
  if (optionCount >= MAX_CHOICE_OPTIONS_EXCLUSIVE) {
    throw new IntentRoutingVocabularyError(
      `Intent-routing ${vocabularyName} vocabulary must contain fewer than 255 options`,
    )
  }

  const criteria = options.map(({ name, description }) => [name, description] as const)
  return Object.fromEntries(
    noneDescription === undefined ? criteria : [...criteria, ["none", noneDescription]],
  )
}

export function buildIntentRoutingQuestions(vocab: IntentRoutingVocabulary) {
  return {
    intent: {
      type: "choice",
      instructions: "Classify the user's current turn by its primary intent.",
      criteria: buildChoiceCriteria("intents", vocab.intents),
    },
    category: {
      type: "choice",
      instructions:
        "Select the delegation category best suited to the current turn, or none when category delegation is not required.",
      criteria: buildChoiceCriteria(
        "categories",
        vocab.categories,
        "The turn required no category delegation.",
      ),
    },
    subagent: {
      type: "choice",
      instructions:
        "Select the named subagent best suited to the current turn, or none when subagent delegation is not required.",
      criteria: buildChoiceCriteria(
        "subagents",
        vocab.subagents,
        "The turn required no subagent delegation.",
      ),
    },
    ambiguous: {
      type: "noul",
      instructions: "Does the current turn require clarification before acting?",
      criteria: {
        true: "Multiple materially different interpretations remain.",
        false: "The turn has one actionable interpretation or a reasonable default.",
      },
    },
  } as const satisfies Questions
}

function failedResult(reason: DecisionUnavailableReason, latencyMs: number, truncatedInput: boolean): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed",
    unavailableReason: reason,
    resolvedModel: null,
    latencyMs,
    truncatedInput,
    answers: null,
    labels: null,
    invalidAnswerCount: 0,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
  }
}
function recordChoiceAnswer(question: ChoiceQuestion, raw: unknown): IntentRoutingChoiceAnswer {
  const value = isRecord(raw) ? raw : {}
  const rawProbabilities = isRecord(value.probabilities) ? value.probabilities : {}
  const numericProbabilities = Object.entries(rawProbabilities).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  )
  const probabilities = Object.fromEntries(
    numericProbabilities.length > 0
      ? numericProbabilities
      : Object.keys(question.criteria).map((option) => [option, 0]),
  )
  return {
    choice: typeof value.choice === "string" ? value.choice : "<missing>",
    confidence:
      typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? value.confidence
        : 0,
    probabilities,
    valid: validateAnswer(question, raw),
  }
}

export async function decideIntentRouting(args: {
  readonly backend: DecisionBackend
  readonly input: IntentRoutingInput
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}): Promise<IntentRoutingDecisionResult> {
  let truncatedInput = false
  try {
    if (args.backend.kind === "disabled") return failedResult("disabled", 0, false)
    truncatedInput = args.input.promptText.length > args.maxPromptChars
    const questions = buildIntentRoutingQuestions(args.vocab)
    const outcome = await args.backend.decide({
      state: {
        prompt_text: args.input.promptText.slice(0, args.maxPromptChars),
        truncated_input: truncatedInput,
      },
      questions,
      model: args.model,
    })
    if (outcome.status === "unavailable") {
      return failedResult(outcome.reason, outcome.latencyMs, truncatedInput)
    }

    const raw: Record<string, unknown> = isRecord(outcome.answers) ? outcome.answers : {}
    const intent = recordChoiceAnswer(questions.intent, raw.intent)
    const category = recordChoiceAnswer(questions.category, raw.category)
    const subagent = recordChoiceAnswer(questions.subagent, raw.subagent)
    const rawAmbiguous = raw.ambiguous
    const ambiguousValue = isRecord(rawAmbiguous) ? rawAmbiguous.noul : undefined
    const ambiguous = {
      noul:
        typeof ambiguousValue === "number" && Number.isFinite(ambiguousValue) ? ambiguousValue : 0,
      valid: validateAnswer(questions.ambiguous, rawAmbiguous),
    }
    const answers = { intent, category, subagent, ambiguous }
    const label = (answer: IntentRoutingChoiceAnswer): IntentRoutingThresholdLabel =>
      answer.confidence >= args.confidenceThreshold ? "would_apply" : "would_fall_through"
    // Labels are observational only. They never gate or alter an answer.
    const labels = { intent: label(intent), category: label(category), subagent: label(subagent) }
    return {
      predictionStatus: "filled",
      unavailableReason: null,
      resolvedModel: outcome.model,
      latencyMs: outcome.latencyMs,
      truncatedInput,
      answers,
      labels,
      invalidAnswerCount: Object.values(answers).filter((answer) => !answer.valid).length,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    }
  } catch {
    return failedResult("transport_error", 0, truncatedInput)
  }
}
