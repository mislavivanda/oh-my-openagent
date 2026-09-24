import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"

const VALID_VOCAB = {
  categories: [
    { name: "visual-engineering", description: "Frontend, UI, and design work" },
    { name: "ultrabrain", description: "Hard logic and architecture work" },
    { name: "deep", description: "Autonomous work requiring deep research" },
    { name: "artistry", description: "Creative and unconventional work" },
    { name: "quick", description: "Trivial, focused changes" },
    { name: "unspecified-low", description: "Low-effort uncategorized work" },
    { name: "unspecified-high", description: "High-effort uncategorized work" },
    { name: "writing", description: "Documentation and prose" },
  ],
  subagents: [
    { name: "explore", description: "Codebase investigation" },
    { name: "librarian", description: "External documentation research" },
    { name: "oracle", description: "Architecture consultation" },
  ],
  intents: [
    { name: "research", description: "Research or understanding" },
    { name: "implementation", description: "Explicit implementation" },
    { name: "investigation", description: "Investigation and reporting" },
    { name: "evaluation", description: "Evaluation before action" },
    { name: "fix", description: "Diagnosis and minimal repair" },
    { name: "open-ended", description: "Open-ended change requiring assessment" },
  ],
} as const satisfies IntentRoutingVocabulary

describe("buildIntentRoutingQuestions", () => {
  test("#given runtime vocabulary #when building questions #then exactly four record-aligned keys are returned", () => {
    const questions = buildIntentRoutingQuestions(VALID_VOCAB)

    expect(Object.keys(questions)).toEqual(["intent", "category", "subagent", "ambiguous"])
    expect(questions.ambiguous.type).toBe("noul")
    expect("confidence" in questions.ambiguous).toBe(false)
    expect(INTENT_ROUTING_QUESTION_VERSION).toBe(1)
  })

  test("#given category and subagent vocabularies #when building questions #then each choice has an explicit structured none criterion", () => {
    const questions = buildIntentRoutingQuestions(VALID_VOCAB)

    expect(questions.category.criteria.none).toMatchObject({ description: expect.any(String) })
    expect(questions.subagent.criteria.none).toMatchObject({ description: expect.any(String) })
  })

  test("#given valid vocabulary #when building questions #then all choice labels are non-empty unique and below the SDK limit", () => {
    const questions = buildIntentRoutingQuestions(VALID_VOCAB)

    for (const question of [questions.intent, questions.category, questions.subagent]) {
      const labels = Object.keys(question.criteria)
      expect(labels.every((label) => label.trim().length > 0)).toBe(true)
      expect(new Set(labels).size).toBe(labels.length)
      expect(labels.length).toBeLessThan(255)
    }
  })

  test("#given caller descriptions #when building questions #then choice criteria use one structured description per option", () => {
    const questions = buildIntentRoutingQuestions(VALID_VOCAB)

    expect(questions.intent.criteria.research).toEqual({
      description: VALID_VOCAB.intents[0].description,
    })
    expect(questions.category.criteria.deep).toEqual({
      description: VALID_VOCAB.categories[2].description,
    })
    expect(questions.subagent.criteria.explore).toEqual({
      description: VALID_VOCAB.subagents[0].description,
    })
  })

  test("#given each empty vocabulary list #when building questions #then a named vocabulary error is thrown", () => {
    expect(() => buildIntentRoutingQuestions({ ...VALID_VOCAB, categories: [] })).toThrow(
      IntentRoutingVocabularyError,
    )
    expect(() => buildIntentRoutingQuestions({ ...VALID_VOCAB, subagents: [] })).toThrow(
      IntentRoutingVocabularyError,
    )
    expect(() => buildIntentRoutingQuestions({ ...VALID_VOCAB, intents: [] })).toThrow(
      IntentRoutingVocabularyError,
    )
  })

  test("#given duplicate empty or reserved labels #when building questions #then invalid labels are rejected", () => {
    expect(() =>
      buildIntentRoutingQuestions({
        ...VALID_VOCAB,
        intents: [
          { name: "research", description: "First" },
          { name: "research", description: "Duplicate" },
        ],
      }),
    ).toThrow(IntentRoutingVocabularyError)
    expect(() =>
      buildIntentRoutingQuestions({
        ...VALID_VOCAB,
        categories: [{ name: "", description: "Empty label" }],
      }),
    ).toThrow(IntentRoutingVocabularyError)
    expect(() =>
      buildIntentRoutingQuestions({
        ...VALID_VOCAB,
        subagents: [{ name: "none", description: "Reserved label" }],
      }),
    ).toThrow(IntentRoutingVocabularyError)
  })
})
