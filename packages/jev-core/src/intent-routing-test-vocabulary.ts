import {
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"

const CATEGORY_FIXTURES = [
  { name: "visual-engineering", description: "Frontend, UI, UX, and design work." },
  { name: "ultrabrain", description: "Hard logic and architecture decisions." },
  { name: "deep", description: "Autonomous research plus end-to-end execution." },
  { name: "artistry", description: "Creative and stylistic work." },
  { name: "quick", description: "Single-file changes and typos." },
  { name: "unspecified-low", description: "Unclassifiable but moderate-effort work." },
  { name: "unspecified-high", description: "Unclassifiable but high-effort work." },
  { name: "writing", description: "Prose, docs, and changelogs." },
] as const

const SUBAGENT_FIXTURES = [
  { name: "sisyphus", description: "Main orchestrator." },
  { name: "hephaestus", description: "Autonomous deep worker." },
  { name: "oracle", description: "Architecture and debugging consultant." },
  { name: "librarian", description: "Docs and code search." },
  { name: "explore", description: "Fast codebase reconnaissance." },
  { name: "multimodal-looker", description: "Image and PDF inspection." },
] as const

const INTENT_FIXTURES = [
  { name: "research", description: "The user wants understanding or an explanation." },
  { name: "implementation", description: "The user explicitly asked for code to be written." },
  { name: "investigation", description: "The user wants something looked into and reported." },
  { name: "evaluation", description: "The user wants an opinion or an assessment." },
  { name: "fix", description: "The user reported an error or broken behavior." },
  { name: "open-ended", description: "The user asked for refactoring or general improvement." },
] as const

export function vocabulary(
  overrides: Partial<IntentRoutingVocabulary> = {},
): IntentRoutingVocabulary {
  return {
    categories: CATEGORY_FIXTURES,
    subagents: SUBAGENT_FIXTURES,
    intents: INTENT_FIXTURES,
    ...overrides,
  }
}

type IntentRoutingChoiceKey = "intent" | "category" | "subagent"

export function choiceLabels(
  questions: ReturnType<typeof buildIntentRoutingQuestions>,
  key: IntentRoutingChoiceKey,
): string[] {
  const question = questions[key]
  if (question === undefined || question.type !== "choice") {
    throw new Error(`expected a choice question at key ${key}`)
  }
  return Object.keys(question.criteria)
}
