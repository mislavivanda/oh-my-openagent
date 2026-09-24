import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
  buildIntentRoutingQuestions,
} from "./intent-routing"

const VOCABULARY = {
  categories: [
    { name: "visual-engineering", description: "Frontend, UI, and visual work." },
    { name: "deep", description: "Autonomous multi-step problem solving." },
    { name: "quick", description: "Small, direct changes." },
  ],
  subagents: [
    { name: "explore", description: "Repository exploration." },
    { name: "librarian", description: "External documentation research." },
  ],
  intents: [
    { name: "research", description: "Research or understanding." },
    { name: "implementation", description: "Explicit implementation." },
    { name: "investigation", description: "Investigation and findings." },
    { name: "evaluation", description: "Evaluation before action." },
    { name: "fix", description: "Diagnosis and a minimal fix." },
    { name: "open-ended", description: "Open-ended code change." },
  ],
} as const

describe("buildIntentRoutingQuestions", () => {
  describe("#given plain routing vocabulary", () => {
    describe("#when building the W1 question set", () => {
      test("#then it returns exactly the four answer-aligned question keys", () => {
        const questions = buildIntentRoutingQuestions(VOCABULARY)

        expect(Object.keys(questions)).toEqual(["intent", "category", "subagent", "ambiguous"])
        expect(INTENT_ROUTING_QUESTION_VERSION).toBe(1)
      })

      test("#then category and subagent expose explicit none choices", () => {
        const questions = buildIntentRoutingQuestions(VOCABULARY)

        expect(questions.category.criteria).toHaveProperty("none")
        expect(questions.subagent.criteria).toHaveProperty("none")
      })

      test("#then each choice derives its labels from caller vocabulary", () => {
        const questions = buildIntentRoutingQuestions(VOCABULARY)

        expect(Object.keys(questions.intent.criteria)).toEqual(
          VOCABULARY.intents.map(({ name }) => name),
        )
        expect(Object.keys(questions.category.criteria)).toEqual([
          ...VOCABULARY.categories.map(({ name }) => name),
          "none",
        ])
        expect(Object.keys(questions.subagent.criteria)).toEqual([
          ...VOCABULARY.subagents.map(({ name }) => name),
          "none",
        ])
      })

      test("#then every option label is non-empty and unique", () => {
        const questions = buildIntentRoutingQuestions(VOCABULARY)

        for (const question of [questions.intent, questions.category, questions.subagent]) {
          const labels = Object.keys(question.criteria)
          expect(labels.every((label) => label.trim().length > 0)).toBe(true)
          expect(new Set(labels).size).toBe(labels.length)
        }
      })

      test("#then every choice has fewer than 255 options", () => {
        const questions = buildIntentRoutingQuestions(VOCABULARY)

        for (const question of [questions.intent, questions.category, questions.subagent]) {
          expect(Object.keys(question.criteria).length).toBeLessThan(255)
        }
      })
    })
  })

  describe("#given an empty routing vocabulary", () => {
    describe("#when building the W1 question set", () => {
      test("#then a named vocabulary error is thrown", () => {
        expect(() =>
          buildIntentRoutingQuestions({ categories: [], subagents: [], intents: [] }),
        ).toThrow(IntentRoutingVocabularyError)
      })
    })
  })
})
