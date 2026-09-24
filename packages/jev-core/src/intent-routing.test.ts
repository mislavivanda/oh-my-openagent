import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_MAX_CHOICE_OPTIONS,
  INTENT_ROUTING_NONE_OPTION,
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
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

function vocabulary(overrides: Partial<IntentRoutingVocabulary> = {}): IntentRoutingVocabulary {
  return {
    categories: CATEGORY_FIXTURES,
    subagents: SUBAGENT_FIXTURES,
    intents: INTENT_FIXTURES,
    ...overrides,
  }
}

function choiceLabels(questions: ReturnType<typeof buildIntentRoutingQuestions>, key: string): string[] {
  const question = questions[key]
  if (question === undefined || question.type !== "choice") {
    throw new Error(`expected a choice question at key ${key}`)
  }
  return Object.keys(question.criteria)
}

describe("buildIntentRoutingQuestions", () => {
  describe("#given a populated vocabulary", () => {
    test("#when building the question set #then it has exactly the four W1 question keys", () => {
      const questions = buildIntentRoutingQuestions(vocabulary())

      expect(Object.keys(questions).sort()).toEqual(["ambiguous", "category", "intent", "subagent"])
      expect(questions.intent?.type).toBe("choice")
      expect(questions.category?.type).toBe("choice")
      expect(questions.subagent?.type).toBe("choice")
      expect(questions.ambiguous?.type).toBe("noul")
    })

    test("#when building the question set #then category and subagent each carry an explicit none option", () => {
      const questions = buildIntentRoutingQuestions(vocabulary())

      expect(choiceLabels(questions, "category")).toContain(INTENT_ROUTING_NONE_OPTION)
      expect(choiceLabels(questions, "subagent")).toContain(INTENT_ROUTING_NONE_OPTION)
      expect(choiceLabels(questions, "intent")).not.toContain(INTENT_ROUTING_NONE_OPTION)
    })

    test("#when reading the none option criteria #then each says the turn required no delegation of that kind", () => {
      const questions = buildIntentRoutingQuestions(vocabulary())
      const category = questions.category
      const subagent = questions.subagent
      if (category?.type !== "choice" || subagent?.type !== "choice") {
        throw new Error("expected choice questions for category and subagent")
      }

      expect(category.criteria[INTENT_ROUTING_NONE_OPTION]).toMatch(/no category delegation/i)
      expect(subagent.criteria[INTENT_ROUTING_NONE_OPTION]).toMatch(/no named subagent/i)
    })

    test("#when inspecting every choice option #then labels are non-empty, unique, and described in one line", () => {
      const questions = buildIntentRoutingQuestions(vocabulary())

      for (const key of ["intent", "category", "subagent"]) {
        const labels = choiceLabels(questions, key)
        expect(labels.length).toBeGreaterThan(1)
        expect(new Set(labels).size).toBe(labels.length)
        for (const label of labels) {
          expect(label.trim().length).toBeGreaterThan(0)
        }
        const question = questions[key]
        if (question?.type !== "choice") {
          throw new Error(`expected a choice question at key ${key}`)
        }
        for (const description of Object.values(question.criteria)) {
          expect(typeof description).toBe("string")
          expect(String(description).includes("\n")).toBe(false)
          expect(String(description).trim().length).toBeGreaterThan(0)
        }
      }
    })

    test("#when counting options #then every choice question stays under the SDK option cap", () => {
      const questions = buildIntentRoutingQuestions(vocabulary())

      expect(INTENT_ROUTING_MAX_CHOICE_OPTIONS).toBe(255)
      for (const key of ["intent", "category", "subagent"]) {
        expect(choiceLabels(questions, key).length).toBeLessThan(INTENT_ROUTING_MAX_CHOICE_OPTIONS)
      }
    })

    test("#when the vocabulary carries members not in the builtin defaults #then they appear as options", () => {
      const questions = buildIntentRoutingQuestions(
        vocabulary({ categories: [{ name: "custom-category", description: "A user-defined category." }] })
      )

      expect(choiceLabels(questions, "category")).toEqual(["custom-category", INTENT_ROUTING_NONE_OPTION])
    })
  })

  describe("#given an empty vocabulary", () => {
    test("#when building the question set #then it throws a named error rather than a one-option choice", () => {
      const build = () => buildIntentRoutingQuestions({ categories: [], subagents: [], intents: [] })

      expect(build).toThrow(IntentRoutingVocabularyError)
      expect(build).toThrow(/categories/)
      try {
        build()
        throw new Error("expected buildIntentRoutingQuestions to throw")
      } catch (error) {
        expect((error as Error).name).toBe("IntentRoutingVocabularyError")
      }
    })

    test("#when only the intents list is empty #then it throws naming intents", () => {
      const build = () => buildIntentRoutingQuestions(vocabulary({ intents: [] }))

      expect(build).toThrow(IntentRoutingVocabularyError)
      expect(build).toThrow(/intents/)
    })
  })

  describe("#given a malformed vocabulary", () => {
    test("#when a label repeats #then it throws a named error naming the duplicate", () => {
      const build = () =>
        buildIntentRoutingQuestions(
          vocabulary({
            categories: [
              { name: "quick", description: "First." },
              { name: "quick", description: "Second." },
            ],
          })
        )

      expect(build).toThrow(IntentRoutingVocabularyError)
      expect(build).toThrow(/quick/)
    })

    test("#when a member collides with the reserved none label #then it throws", () => {
      const build = () =>
        buildIntentRoutingQuestions(
          vocabulary({ subagents: [{ name: INTENT_ROUTING_NONE_OPTION, description: "Reserved." }] })
        )

      expect(build).toThrow(IntentRoutingVocabularyError)
      expect(build).toThrow(/reserved/i)
    })

    test("#when a label is blank #then it throws", () => {
      const build = () =>
        buildIntentRoutingQuestions(vocabulary({ categories: [{ name: "  ", description: "Blank." }] }))

      expect(build).toThrow(IntentRoutingVocabularyError)
    })

    test("#when a list exceeds the option cap #then it throws naming the cap", () => {
      const oversized = Array.from({ length: INTENT_ROUTING_MAX_CHOICE_OPTIONS }, (_, index) => ({
        name: `category-${index}`,
        description: "Generated.",
      }))

      const build = () => buildIntentRoutingQuestions(vocabulary({ categories: oversized }))

      expect(build).toThrow(IntentRoutingVocabularyError)
      expect(build).toThrow(/255/)
    })
  })
})

describe("INTENT_ROUTING_QUESTION_VERSION", () => {
  describe("#given the W1 question contract", () => {
    test("#when reading the version #then it is 1", () => {
      expect(INTENT_ROUTING_QUESTION_VERSION).toBe(1)
    })
  })
})
