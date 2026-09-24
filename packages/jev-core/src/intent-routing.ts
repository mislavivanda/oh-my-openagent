import { isRecord } from "./answer-validation"
import {
  emptyDecisionAnswers,
  readChoiceDecision,
  readNoulDecision,
  type IntentRoutingDecisionAnswers,
} from "./intent-routing-answer-observation"
import type {
  ChoiceQuestion,
  DecisionBackend,
  DecisionUnavailableReason,
  NoulQuestion,
  Questions,
} from "./types"

export const INTENT_ROUTING_QUESTION_VERSION = 1

export type IntentRoutingVocabularyEntry = {
  readonly name: string
  readonly description: string
}

export type IntentRoutingVocabulary = {
  readonly categories: readonly IntentRoutingVocabularyEntry[]
  readonly subagents: readonly IntentRoutingVocabularyEntry[]
  readonly intents: readonly IntentRoutingVocabularyEntry[]
}

export type IntentRoutingQuestions = {
  readonly intent: ChoiceQuestion
  readonly category: ChoiceQuestion
  readonly subagent: ChoiceQuestion
  readonly ambiguous: NoulQuestion
}

export type IntentRoutingInput = {
  readonly promptText: string
}

export type {
  IntentRoutingChoiceLabel,
  IntentRoutingDecisionAnswers,
  IntentRoutingDecisionChoice,
} from "./intent-routing-answer-observation"

export type IntentRoutingDecisionResult = {
  readonly predictionStatus: "filled" | "failed"
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly answers: IntentRoutingDecisionAnswers
  readonly invalidAnswerCount: number
  readonly truncatedInput: boolean
  readonly threshold: number
  readonly questionVersion: number
}

type IntentRoutingVocabularyName = keyof IntentRoutingVocabulary

export class IntentRoutingVocabularyError extends Error {
  constructor(
    public readonly vocabulary: IntentRoutingVocabularyName,
    public readonly issue: string,
  ) {
    super(`Invalid intent routing ${vocabulary} vocabulary: ${issue}`)
    this.name = "IntentRoutingVocabularyError"
  }
}

const MAX_CHOICE_OPTION_COUNT = 254
const RESERVED_NONE_LABEL = "none"

function validateEntries(
  vocabulary: IntentRoutingVocabularyName,
  entries: readonly IntentRoutingVocabularyEntry[],
  reservesNone: boolean,
): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new IntentRoutingVocabularyError(vocabulary, "must contain at least one entry")
  }

  const totalOptions = entries.length + (reservesNone ? 1 : 0)
  if (totalOptions > MAX_CHOICE_OPTION_COUNT) {
    throw new IntentRoutingVocabularyError(
      vocabulary,
      `must produce at most ${MAX_CHOICE_OPTION_COUNT} choice options`,
    )
  }

  const names = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new IntentRoutingVocabularyError(vocabulary, `entry ${index} must be an object`)
    }
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw new IntentRoutingVocabularyError(vocabulary, `entry ${index} must have a non-empty name`)
    }
    if (reservesNone && entry.name === RESERVED_NONE_LABEL) {
      throw new IntentRoutingVocabularyError(vocabulary, `entry ${index} uses reserved name "none"`)
    }
    if (names.has(entry.name)) {
      throw new IntentRoutingVocabularyError(vocabulary, `contains duplicate name "${entry.name}"`)
    }
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
      throw new IntentRoutingVocabularyError(
        vocabulary,
        `entry ${index} must have a non-empty description`,
      )
    }
    names.add(entry.name)
  }
}

function buildCriteria(
  entries: readonly IntentRoutingVocabularyEntry[],
): Readonly<Record<string, { readonly description: string }>> {
  return Object.fromEntries(
    entries.map((entry) => [entry.name, { description: entry.description }] as const),
  )
}

export function buildIntentRoutingQuestions(
  vocab: IntentRoutingVocabulary,
): IntentRoutingQuestions {
  validateEntries("intents", vocab.intents, false)
  validateEntries("categories", vocab.categories, true)
  validateEntries("subagents", vocab.subagents, true)

  return {
    intent: {
      type: "choice",
      instructions: "Classify the current user turn by its true intent.",
      criteria: buildCriteria(vocab.intents),
    },
    category: {
      type: "choice",
      instructions: "Choose the category delegation required for the current turn.",
      criteria: {
        ...buildCriteria(vocab.categories),
        none: { description: "The turn required no category delegation." },
      },
    },
    subagent: {
      type: "choice",
      instructions: "Choose the named subagent delegation required for the current turn.",
      criteria: {
        ...buildCriteria(vocab.subagents),
        none: { description: "The turn required no subagent delegation." },
      },
    },
    ambiguous: {
      type: "noul",
      instructions: "Estimate whether the current turn has multiple materially different interpretations.",
      criteria: {
        true: "Multiple interpretations could change the route or required effort.",
        false: "One interpretation is sufficient to choose the route.",
      },
    },
  } as const satisfies Questions
}

function failedDecisionResult(args: {
  readonly unavailableReason: DecisionUnavailableReason
  readonly latencyMs: number
  readonly truncatedInput: boolean
  readonly threshold: number
}): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed",
    unavailableReason: args.unavailableReason,
    resolvedModel: null,
    latencyMs: args.latencyMs,
    answers: emptyDecisionAnswers(),
    invalidAnswerCount: 0,
    truncatedInput: args.truncatedInput,
    threshold: args.threshold,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
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
  const startedAt = performance.now()
  let truncatedInput = false
  try {
    const maxPromptChars = Number.isSafeInteger(args.maxPromptChars) && args.maxPromptChars >= 0
      ? args.maxPromptChars
      : 0
    const promptText = args.input.promptText.slice(0, maxPromptChars)
    truncatedInput = promptText.length < args.input.promptText.length
    const questions = buildIntentRoutingQuestions(args.vocab)

    if (args.backend.kind === "disabled") {
      return failedDecisionResult({
        unavailableReason: "disabled",
        latencyMs: performance.now() - startedAt,
        truncatedInput,
        threshold: args.confidenceThreshold,
      })
    }

    const outcome = await args.backend.decide({
      state: { promptText, truncatedInput },
      questions,
      model: args.model,
    })
    if (outcome.status === "unavailable") {
      return failedDecisionResult({
        unavailableReason: outcome.reason,
        latencyMs: outcome.latencyMs,
        truncatedInput,
        threshold: args.confidenceThreshold,
      })
    }

    const rawAnswers: unknown = outcome.answers
    const answerRecord = isRecord(rawAnswers) ? rawAnswers : {}
    const answers = {
      intent: readChoiceDecision(questions.intent, answerRecord.intent, args.confidenceThreshold),
      category: readChoiceDecision(questions.category, answerRecord.category, args.confidenceThreshold),
      subagent: readChoiceDecision(questions.subagent, answerRecord.subagent, args.confidenceThreshold),
      ambiguous: readNoulDecision(questions.ambiguous, answerRecord.ambiguous),
    }
    const expectedKeys = Object.keys(questions)
    const unexpectedAnswerCount = Object.keys(answerRecord)
      .filter((key) => !expectedKeys.includes(key)).length
    const invalidAnswerCount = Object.values(answers)
      .filter((answer) => !answer.valid).length + unexpectedAnswerCount

    return {
      predictionStatus: "filled",
      unavailableReason: null,
      resolvedModel: outcome.model,
      latencyMs: outcome.latencyMs,
      answers,
      invalidAnswerCount,
      truncatedInput,
      threshold: args.confidenceThreshold,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    }
  } catch {
    return failedDecisionResult({
      unavailableReason: "transport_error",
      latencyMs: performance.now() - startedAt,
      truncatedInput,
      threshold: args.confidenceThreshold,
    })
  }
}
