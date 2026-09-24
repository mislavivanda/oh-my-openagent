import { describe, expect, spyOn, test } from "bun:test"
import { choiceAnswer, createMockDecisionBackend } from "./mock-backend"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
  buildIntentRoutingQuestions,
  decideIntentRouting,
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

const INTENT_OPTIONS = VOCABULARY.intents.map(({ name }) => name)
const CATEGORY_OPTIONS = [...VOCABULARY.categories.map(({ name }) => name), "none"]
const SUBAGENT_OPTIONS = [...VOCABULARY.subagents.map(({ name }) => name), "none"]

function validAnswers() {
  return {
    intent: choiceAnswer("implementation", 0.9, INTENT_OPTIONS),
    category: choiceAnswer("deep", 0.9, CATEGORY_OPTIONS),
    subagent: choiceAnswer("none", 0.9, SUBAGENT_OPTIONS),
    ambiguous: { type: "noul", noul: 0.1 } as const,
  }
}

function createValidBackend() {
  return createMockDecisionBackend(validAnswers(), { model: "jev-intent-2026-09-24" })
}

function decide(
  backend: ReturnType<typeof createMockDecisionBackend>,
  promptText = "Implement the requested routing change.",
  maxPromptChars = 2000,
) {
  return decideIntentRouting({
    backend,
    input: { promptText },
    vocab: VOCABULARY,
    confidenceThreshold: 0.8,
    model: "jev-latest",
    maxPromptChars,
  })
}

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

describe("decideIntentRouting", () => {
  describe("#given four valid answers above the threshold", () => {
    test("#then one backend call labels every Choice answer without labelling Noul", async () => {
      const backend = createValidBackend()
      const decideSpy = spyOn(backend, "decide")

      const result = await decide(backend)

      expect(decideSpy).toHaveBeenCalledTimes(1)
      expect(Object.keys(decideSpy.mock.calls[0]?.[0].questions ?? {})).toEqual([
        "intent",
        "category",
        "subagent",
        "ambiguous",
      ])
      expect(result.predictionStatus).toBe("filled")
      expect(result.labels).toEqual({
        intent: "would_apply",
        category: "would_apply",
        subagent: "would_apply",
      })
      expect(result.labels).not.toHaveProperty("ambiguous")
      expect(result.answers?.ambiguous).toEqual({ noul: 0.1, valid: true })
      expect(result.answers?.ambiguous).not.toHaveProperty("confidence")
      expect(result.resolvedModel).toBe("jev-intent-2026-09-24")
      expect(result.invalidAnswerCount).toBe(0)
    })
  })

  describe("#given one Choice answer below the threshold", () => {
    test("#then that answer alone is labelled would_fall_through", async () => {
      const backend = createMockDecisionBackend(
        {
          ...validAnswers(),
          category: choiceAnswer("deep", 0.7, CATEGORY_OPTIONS),
        },
        { model: "jev-intent-2026-09-24" },
      )

      const result = await decide(backend)

      expect(result.labels).toEqual({
        intent: "would_apply",
        category: "would_fall_through",
        subagent: "would_apply",
      })
      expect(result.predictionStatus).toBe("filled")
    })
  })

  describe("#given a decided response with an out-of-set choice", () => {
    test("#then the raw choice is retained, invalid, and counted", async () => {
      const backend = createValidBackend()
      const answers = {
        ...validAnswers(),
        category: {
          type: "choice",
          choice: "outside-vocabulary",
          confidence: 0.9,
          probabilities: { deep: 0.1, none: 0, quick: 0, "visual-engineering": 0, "outside-vocabulary": 0.9 },
        },
      }
      Object.defineProperty(backend, "decide", {
        value: async () => ({
          status: "decided",
          answers,
          model: "jev-intent-2026-09-24",
          usage: { input_tokens: 1, output_tokens: 1 },
          latencyMs: 1,
        }),
      })

      const result = await decide(backend)

      expect(result.answers?.category.choice).toBe("outside-vocabulary")
      expect(result.answers?.category.valid).toBe(false)
      expect(result.invalidAnswerCount).toBe(1)
    })
  })

  describe("#given a decided response missing one question key", () => {
    test("#then the missing answer remains visible, invalid, and counted", async () => {
      const backend = createValidBackend()
      const { subagent: _missing, ...answers } = validAnswers()
      Object.defineProperty(backend, "decide", {
        value: async () => ({
          status: "decided",
          answers,
          model: "jev-intent-2026-09-24",
          usage: { input_tokens: 1, output_tokens: 1 },
          latencyMs: 1,
        }),
      })

      const result = await decide(backend)

      expect(result.answers?.subagent.choice).toBe("<missing>")
      expect(result.answers?.subagent.valid).toBe(false)
      expect(result.invalidAnswerCount).toBe(1)
    })
  })

  describe("#given an unavailable backend", () => {
    test("#then prediction fails with the unavailable reason", async () => {
      const result = await decide(createMockDecisionBackend({}))

      expect(result.predictionStatus).toBe("failed")
      expect(result.unavailableReason).toBe("unscripted")
      expect(result.answers).toBeNull()
    })
  })

  describe("#given a backend whose decide rejects", () => {
    test("#then a rejecting backend returns failed without throwing", async () => {
      const backend = createValidBackend()
      Object.defineProperty(backend, "decide", {
        value: async () => {
          throw new Error("backend rejected")
        },
      })
      const invoke = () => decide(backend)

      expect(invoke).not.toThrow()
      const result = await invoke()

      expect(result.predictionStatus).toBe("failed")
      expect(result.unavailableReason).toBe("transport_error")
    })
  })

  describe("#given a prompt longer than maxPromptChars", () => {
    test("#then the structured state marks truncation and bounds prompt text", async () => {
      const backend = createValidBackend()
      const decideSpy = spyOn(backend, "decide")

      const result = await decide(backend, "0123456789", 4)

      expect(result.truncatedInput).toBe(true)
      expect(decideSpy.mock.calls[0]?.[0].state).toEqual({
        prompt_text: "0123",
        truncated_input: true,
      })
    })
  })
})
