import { describe, expect, test } from "bun:test"
import { isRecord } from "./answer-validation"
import {
  INTENT_ROUTING_MAX_CHOICE_OPTIONS,
  INTENT_ROUTING_NONE_OPTION,
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import * as intentRoutingModule from "./intent-routing"
import { choiceAnswer, createMockDecisionBackend, type MockDecisionScript } from "./mock-backend"
import type {
  DecisionBackend,
  DecisionRequest,
  DecisionState,
  DecisionUnavailableReason,
  Questions,
} from "./types"

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

type IntentRoutingChoiceKey = "intent" | "category" | "subagent"

function choiceLabels(
  questions: ReturnType<typeof buildIntentRoutingQuestions>,
  key: IntentRoutingChoiceKey,
): string[] {
  const question = questions[key]
  if (question === undefined || question.type !== "choice") {
    throw new Error(`expected a choice question at key ${key}`)
  }
  return Object.keys(question.criteria)
}

type ExpectedDecisionLabel = "would_apply" | "would_fall_through"

type ExpectedDecisionChoiceAnswer = {
  readonly choice: unknown
  readonly confidence: unknown
  readonly probabilities: unknown
  readonly valid: boolean
  readonly label: ExpectedDecisionLabel | null
}

type ExpectedDecisionAnswers = {
  readonly intent: ExpectedDecisionChoiceAnswer
  readonly category: ExpectedDecisionChoiceAnswer
  readonly subagent: ExpectedDecisionChoiceAnswer
  readonly ambiguous: { readonly noul: unknown; readonly valid: boolean }
}

type ExpectedDecisionResult = {
  readonly predictionStatus: "filled" | "failed"
  readonly truncatedInput: boolean
  readonly answers: ExpectedDecisionAnswers | null
  readonly invalidAnswerCount: number
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly threshold: number
  readonly questionVersion: number
}

type ExpectedDecisionFunction = (args: {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}) => Promise<ExpectedDecisionResult>

function isExpectedDecisionFunction(value: unknown): value is ExpectedDecisionFunction {
  return typeof value === "function"
}

function decisionFunction(): ExpectedDecisionFunction {
  const candidate: unknown = Reflect.get(intentRoutingModule, "decideIntentRouting")
  expect(typeof candidate).toBe("function")
  if (!isExpectedDecisionFunction(candidate)) {
    throw new TypeError("decideIntentRouting must be exported from intent-routing")
  }
  return candidate
}

function routingScript(confidence: Partial<Record<"intent" | "category" | "subagent", number>> = {}): MockDecisionScript {
  const questions = buildIntentRoutingQuestions(vocabulary())
  return {
    intent: choiceAnswer("implementation", confidence.intent ?? 0.92, choiceLabels(questions, "intent")),
    category: choiceAnswer("quick", confidence.category ?? 0.91, choiceLabels(questions, "category")),
    subagent: choiceAnswer(INTENT_ROUTING_NONE_OPTION, confidence.subagent ?? 0.9, choiceLabels(questions, "subagent")),
    ambiguous: { type: "noul", noul: 0.12 },
  }
}

function requireAnswers(result: ExpectedDecisionResult): ExpectedDecisionAnswers {
  expect(result.predictionStatus).toBe("filled")
  expect(result.answers).not.toBeNull()
  if (result.answers === null) throw new TypeError("expected filled intent-routing answers")
  return result.answers
}

function createTrackedBackend(base: DecisionBackend): {
  readonly backend: DecisionBackend
  readonly calls: () => number
  readonly state: () => DecisionState | undefined
  readonly questionKeys: () => readonly string[]
} {
  let calls = 0
  let state: DecisionState | undefined
  let questionKeys: readonly string[] = []
  return {
    backend: {
      kind: base.kind,
      async decide<Q extends Questions>(request: DecisionRequest<Q>) {
        calls += 1
        state = request.state
        questionKeys = Object.keys(request.questions)
        return base.decide(request)
      },
    },
    calls: () => calls,
    state: () => state,
    questionKeys: () => questionKeys,
  }
}

function createCorruptingMock(corrupt: (answers: object) => void): DecisionBackend {
  const base = createMockDecisionBackend(routingScript(), { model: "jev-2026-09-24" })
  return {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>) {
      const outcome = await base.decide(request)
      if (outcome.status === "decided") corrupt(outcome.answers)
      return outcome
    },
  }
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

      for (const key of ["intent", "category", "subagent"] as const) {
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
      for (const key of ["intent", "category", "subagent"] as const) {
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

describe("decideIntentRouting", () => {
  describe("#given valid answers above the confidence threshold", () => {
    test("#when deciding all four questions #then choice answers are labelled would_apply and ambiguous has no confidence or label", async () => {
      const tracked = createTrackedBackend(
        createMockDecisionBackend(routingScript(), { model: "jev-2026-09-24" })
      )

      const result = await decisionFunction()({
        backend: tracked.backend,
        input: { promptText: "Implement the focused routing change." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        model: "jev-latest",
        maxPromptChars: 8000,
      })
      const answers = requireAnswers(result)

      expect(tracked.calls()).toBe(1)
      expect(tracked.questionKeys().toSorted()).toEqual(["ambiguous", "category", "intent", "subagent"])
      expect(answers.intent.label).toBe("would_apply")
      expect(answers.category.label).toBe("would_apply")
      expect(answers.subagent.label).toBe("would_apply")
      expect(answers.ambiguous).toEqual({ noul: 0.12, valid: true })
      expect(Reflect.has(answers.ambiguous, "confidence")).toBe(false)
      expect(Reflect.has(answers.ambiguous, "label")).toBe(false)
      expect(result.invalidAnswerCount).toBe(0)
      expect(result.resolvedModel).toBe("jev-2026-09-24")
      expect(result.resolvedModel).not.toBe("jev-latest")
      expect(result.unavailableReason).toBeNull()
      expect(result.threshold).toBe(0.8)
      expect(result.questionVersion).toBe(INTENT_ROUTING_QUESTION_VERSION)
    })
  })

  describe("#given one answer below the confidence threshold", () => {
    test("#when deciding #then only that question is labelled would_fall_through without gating the result", async () => {
      const result = await decisionFunction()({
        backend: createMockDecisionBackend(routingScript({ category: 0.79 })),
        input: { promptText: "Polish this small component." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars: 8000,
      })
      const answers = requireAnswers(result)

      expect(answers.intent.label).toBe("would_apply")
      expect(answers.category.label).toBe("would_fall_through")
      expect(answers.subagent.label).toBe("would_apply")
      expect(result.predictionStatus).toBe("filled")
      expect(result.invalidAnswerCount).toBe(0)
    })
  })

  describe("#given a mock answer whose choice is outside the declared option set", () => {
    test("#when deciding #then the raw choice is retained, marked invalid, and counted", async () => {
      const backend = createCorruptingMock((answers) => {
        Reflect.set(answers, "intent", {
          type: "choice",
          choice: "outside-intent",
          confidence: 0.91,
          probabilities: { "outside-intent": 0.91, implementation: 0.09 },
        })
      })

      const result = await decisionFunction()({
        backend,
        input: { promptText: "Do something." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars: 8000,
      })
      const answers = requireAnswers(result)

      expect(answers.intent.choice).toBe("outside-intent")
      expect(answers.intent.confidence).toBe(0.91)
      expect(answers.intent.probabilities).toEqual({ "outside-intent": 0.91, implementation: 0.09 })
      expect(answers.intent.valid).toBe(false)
      expect(answers.intent.label).toBe("would_apply")
      expect(result.invalidAnswerCount).toBe(1)
    })
  })

  describe("#given a decided outcome missing one question key", () => {
    test("#when deciding #then the missing raw fields remain explicit undefined values and count as invalid", async () => {
      const backend = createCorruptingMock((answers) => {
        Reflect.deleteProperty(answers, "category")
      })

      const result = await decisionFunction()({
        backend,
        input: { promptText: "Do something." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars: 8000,
      })
      const answers = requireAnswers(result)

      expect(Object.hasOwn(answers, "category")).toBe(true)
      expect(Object.hasOwn(answers.category, "choice")).toBe(true)
      expect(answers.category.choice).toBeUndefined()
      expect(answers.category.confidence).toBeUndefined()
      expect(answers.category.probabilities).toBeUndefined()
      expect(answers.category.valid).toBe(false)
      expect(answers.category.label).toBeNull()
      expect(result.invalidAnswerCount).toBe(1)
    })
  })

  describe("#given an unavailable backend outcome", () => {
    test("#when deciding #then prediction fails and propagates the unavailable reason", async () => {
      const backend: DecisionBackend = {
        kind: "mock",
        async decide() {
          return { status: "unavailable", reason: "timeout", latencyMs: 17 }
        },
      }

      const result = await decisionFunction()({
        backend,
        input: { promptText: "Route this." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars: 8000,
      })

      expect(result.predictionStatus).toBe("failed")
      expect(result.unavailableReason).toBe("timeout")
      expect(result.answers).toBeNull()
      expect(result.resolvedModel).toBeNull()
      expect(result.latencyMs).toBe(17)
    })
  })

  describe("#given a backend whose decide method rejects", () => {
    test("#when deciding with a throwing backend #then prediction fails and no exception escapes", async () => {
      const backend: DecisionBackend = {
        kind: "mock",
        async decide() {
          throw new Error("transport rejected")
        },
      }
      let pending: Promise<ExpectedDecisionResult> | undefined
      const invoke = () => {
        pending = decisionFunction()({
          backend,
          input: { promptText: "Route this." },
          vocab: vocabulary(),
          confidenceThreshold: 0.8,
          maxPromptChars: 8000,
        })
      }

      expect(invoke).not.toThrow()
      expect(pending).toBeDefined()
      if (pending === undefined) throw new TypeError("expected decideIntentRouting to return a promise")
      const result = await pending

      expect(result.predictionStatus).toBe("failed")
      expect(result.unavailableReason).toBe("transport_error")
      expect(result.answers).toBeNull()
    })
  })

  describe("#given a prompt longer than maxPromptChars", () => {
    test("#when deciding #then the structured state carries a bounded prompt and truncatedInput true", async () => {
      const tracked = createTrackedBackend(createMockDecisionBackend(routingScript()))
      const maxPromptChars = 32
      const promptText = "x".repeat(maxPromptChars + 50)

      const result = await decisionFunction()({
        backend: tracked.backend,
        input: { promptText },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars,
      })
      const state = tracked.state()

      expect(result.truncatedInput).toBe(true)
      expect(isRecord(state)).toBe(true)
      if (!isRecord(state)) throw new TypeError("expected structured decision state")
      expect(state.promptText).toBe("x".repeat(maxPromptChars))
      expect(String(state.promptText).length).toBeLessThanOrEqual(maxPromptChars)
      expect(state.truncatedInput).toBe(true)
    })
  })

  describe("#given a disabled backend", () => {
    test("#when deciding #then it short-circuits without calling decide", async () => {
      let calls = 0
      const backend: DecisionBackend = {
        kind: "disabled",
        async decide() {
          calls += 1
          throw new Error("disabled backend must not be called")
        },
      }

      const result = await decisionFunction()({
        backend,
        input: { promptText: "Route this." },
        vocab: vocabulary(),
        confidenceThreshold: 0.8,
        maxPromptChars: 8000,
      })

      expect(calls).toBe(0)
      expect(result.predictionStatus).toBe("failed")
      expect(result.unavailableReason).toBe("disabled")
    })
  })
})
