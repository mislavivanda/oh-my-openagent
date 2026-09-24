import type { ChoiceQuestion, NoulQuestion } from "./types"

export const INTENT_ROUTING_QUESTION_VERSION = 1

/** Label used when a turn required no delegation of the kind a question asks about. */
export const INTENT_ROUTING_NONE_OPTION = "none"

/** Upper bound on Choice options accepted by the decision backend. */
export const INTENT_ROUTING_MAX_CHOICE_OPTIONS = 255

/** Raised when the caller-supplied vocabulary cannot produce a well-formed question set. */
export class IntentRoutingVocabularyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntentRoutingVocabularyError"
  }
}

export type IntentRoutingVocabularyEntry = {
  readonly name: string
  readonly description: string
}

/**
 * Plain, harness-neutral routing vocabulary. The caller owns these lists so the
 * option set always tracks the runtime vocabulary instead of a frozen literal.
 */
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

const NONE_CATEGORY_DESCRIPTION =
  "The turn required no category delegation at all, for example a plain question, a direct answer, or work the orchestrator did itself."

const NONE_SUBAGENT_DESCRIPTION =
  "The turn required no named subagent at all, for example a plain question, a direct answer, or work the orchestrator did itself."

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function buildCriteria(
  kind: string,
  entries: readonly IntentRoutingVocabularyEntry[],
  noneDescription: string | null
): Record<string, string | null> {
  if (entries.length === 0) {
    throw new IntentRoutingVocabularyError(
      `intent-routing vocabulary is empty: ${kind} must declare at least one option, otherwise the choice collapses to a single label and measures nothing`
    )
  }

  const reservedCount = noneDescription === null ? 0 : 1
  const total = entries.length + reservedCount
  if (total > INTENT_ROUTING_MAX_CHOICE_OPTIONS) {
    throw new IntentRoutingVocabularyError(
      `intent-routing vocabulary is too large: ${kind} would produce ${total} options and exceeds the maximum of ${INTENT_ROUTING_MAX_CHOICE_OPTIONS}`
    )
  }

  const criteria: Record<string, string | null> = {}
  for (const entry of entries) {
    const label = toSingleLine(entry.name)
    if (label.length === 0) {
      throw new IntentRoutingVocabularyError(
        `intent-routing vocabulary has a blank label in ${kind}: every option needs a non-empty name`
      )
    }
    if (reservedCount === 1 && label === INTENT_ROUTING_NONE_OPTION) {
      throw new IntentRoutingVocabularyError(
        `intent-routing vocabulary uses the reserved label "${INTENT_ROUTING_NONE_OPTION}" in ${kind}: it is minted by the builder to mark turns needing no delegation`
      )
    }
    if (label in criteria) {
      throw new IntentRoutingVocabularyError(
        `intent-routing vocabulary has a duplicate label in ${kind}: "${label}" appears more than once`
      )
    }
    const description = toSingleLine(entry.description)
    criteria[label] = description.length === 0 ? null : description
  }

  if (noneDescription !== null) {
    criteria[INTENT_ROUTING_NONE_OPTION] = noneDescription
  }
  return criteria
}

function choiceQuestion(instructions: string, criteria: Record<string, string | null>): ChoiceQuestion {
  return { type: "choice", instructions, criteria }
}

const INTENT_INSTRUCTIONS =
  "An AI coding harness received the user turn described in the state. Decide which intent class best describes what the user is asking the orchestrator to do."

const CATEGORY_INSTRUCTIONS =
  "An AI coding harness received the user turn described in the state. Decide which delegation category the orchestrator should route this turn to, or none when the turn needs no category delegation."

const SUBAGENT_INSTRUCTIONS =
  "An AI coding harness received the user turn described in the state. Decide which named subagent the orchestrator should route this turn to, or none when the turn needs no named subagent."

const AMBIGUOUS_QUESTION: NoulQuestion = {
  type: "noul",
  instructions:
    "An AI coding harness received the user turn described in the state. Decide whether the turn is ambiguous enough that the orchestrator should ask a clarifying question before acting.",
  criteria: {
    true: "The turn has multiple plausible interpretations with materially different effort, or it is missing information the orchestrator needs before acting.",
    false: "The turn has a single reasonable interpretation the orchestrator can act on without asking anything first.",
  },
}

/**
 * Build the four W1 observation questions from a caller-supplied vocabulary.
 * The category and subagent questions each carry an explicit `none` option, so a
 * pure question turn is not forced to name a delegation target it never needed.
 */
export function buildIntentRoutingQuestions(vocab: IntentRoutingVocabulary): IntentRoutingQuestions {
  const categoryCriteria = buildCriteria("categories", vocab.categories, NONE_CATEGORY_DESCRIPTION)
  const subagentCriteria = buildCriteria("subagents", vocab.subagents, NONE_SUBAGENT_DESCRIPTION)
  const intentCriteria = buildCriteria("intents", vocab.intents, null)

  return {
    intent: choiceQuestion(INTENT_INSTRUCTIONS, intentCriteria),
    category: choiceQuestion(CATEGORY_INSTRUCTIONS, categoryCriteria),
    subagent: choiceQuestion(SUBAGENT_INSTRUCTIONS, subagentCriteria),
    ambiguous: AMBIGUOUS_QUESTION,
  }
}

export {
  decideIntentRouting,
  type IntentRoutingDecisionAnswers,
  type IntentRoutingDecisionChoiceAnswer,
  type IntentRoutingDecisionLabel,
  type IntentRoutingDecisionResult,
} from "./intent-routing-decision"
