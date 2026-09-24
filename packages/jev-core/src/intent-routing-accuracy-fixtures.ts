import {
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import {
  INTENT_ROUTING_FIXTURES,
  INTENT_ROUTING_FIXTURE_CATEGORIES,
  INTENT_ROUTING_FIXTURE_INTENTS,
  type IntentRoutingFixture,
} from "./intent-routing-fixtures"
import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "./intent-routing-normalization"
import {
  choiceAnswer,
  createMockDecisionBackend,
  type MockDecisionScript,
} from "./mock-backend"
import type { DecisionBackend, DecisionRequest } from "./types"

export const MODEL_ALIAS = "jev-latest"
export const MOCK_RESOLVED_MODEL = "mock/jev-intent-routing-v1"

const toEntries = (names: readonly string[]) => (
  names.map((name) => ({ name, description: `${name} routing option.` }))
)

export const VOCABULARY = {
  categories: toEntries(INTENT_ROUTING_FIXTURE_CATEGORIES),
  subagents: toEntries(INTENT_ROUTING_SUBAGENT_VOCABULARY),
  intents: toEntries(INTENT_ROUTING_FIXTURE_INTENTS),
} satisfies IntentRoutingVocabulary

export const QUESTIONS = buildIntentRoutingQuestions(VOCABULARY)

export function buildAccuracyRequest(
  fixture: IntentRoutingFixture,
): DecisionRequest<typeof QUESTIONS> {
  if (
    !(fixture.label.intent in QUESTIONS.intent.criteria)
    || !(fixture.label.category in QUESTIONS.category.criteria)
    || !(fixture.label.subagent in QUESTIONS.subagent.criteria)
  ) {
    throw new TypeError(`fixture ${fixture.id} has a label outside the question vocabulary`)
  }
  return {
    state: { promptText: fixture.input.promptText, truncatedInput: false },
    questions: QUESTIONS,
    model: MODEL_ALIAS,
  }
}

export function createFixtureMockBackend(fixture: IntentRoutingFixture): DecisionBackend {
  const script: MockDecisionScript = {
    intent: choiceAnswer(fixture.label.intent, 0.99, Object.keys(QUESTIONS.intent.criteria)),
    category: choiceAnswer(fixture.label.category, 0.99, Object.keys(QUESTIONS.category.criteria)),
    subagent: choiceAnswer(fixture.label.subagent, 0.99, Object.keys(QUESTIONS.subagent.criteria)),
    ambiguous: { type: "noul", noul: fixture.label.ambiguous ? 0.99 : 0.01 },
  }
  return createMockDecisionBackend(script, { model: MOCK_RESOLVED_MODEL })
}

export { INTENT_ROUTING_FIXTURES }
