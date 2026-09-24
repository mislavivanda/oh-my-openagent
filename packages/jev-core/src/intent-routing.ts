import type { Questions } from "./types"

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
