import { describe, expect, test } from "bun:test"
import * as intentRouting from "./intent-routing"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingVocabularyError,
  buildIntentRoutingQuestions,
  decideIntentRouting,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import { choiceAnswer, createMockDecisionBackend } from "./mock-backend"
import type {
  DecisionBackend,
  DecisionOutcome,
  DecisionRequest,
  DecisionState,
  DecisionUnavailableReason,
  Questions,
} from "./types"

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

const INTENT_OPTIONS = VALID_VOCAB.intents.map((entry) => entry.name)
const CATEGORY_OPTIONS = [...VALID_VOCAB.categories.map((entry) => entry.name), "none"]
const SUBAGENT_OPTIONS = [...VALID_VOCAB.subagents.map((entry) => entry.name), "none"]

function validAnswers(categoryConfidence = 0.95) {
  return {
    intent: choiceAnswer("implementation", 0.95, INTENT_OPTIONS),
    category: choiceAnswer("deep", categoryConfidence, CATEGORY_OPTIONS),
    subagent: choiceAnswer("none", 0.95, SUBAGENT_OPTIONS),
    ambiguous: { type: "noul", noul: 0.1 },
  } as const
}

function createRawBackend(answers: unknown, model = "jev-resolved-v1"): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return JSON.parse(JSON.stringify({
        status: "decided",
        answers,
        model,
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 7,
      }))
    },
  }
}

function createUnavailableBackend(reason: DecisionUnavailableReason): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return { status: "unavailable", reason, latencyMs: 3 }
    },
  }
}

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

describe("decideIntentRouting", () => {
  test("#given the intent-routing module #when loading its public surface #then the decision function exists", () => {
    expect(typeof Reflect.get(intentRouting, "decideIntentRouting")).toBe("function")
  })

  test("#given four valid answers above threshold #when deciding #then choice labels apply and the resolved model is recorded", async () => {
    let calls = 0
    let questionKeys: string[] = []
    const delegate = createMockDecisionBackend(validAnswers(), { model: "jev-resolved-v1" })
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
        calls += 1
        questionKeys = Object.keys(request.questions)
        return delegate.decide(request)
      },
    }

    const result = await decideIntentRouting({
      backend, input: { promptText: "Implement the requested change" }, vocab: VALID_VOCAB,
      confidenceThreshold: 0.8, model: "jev-latest", maxPromptChars: 200,
    })

    expect(calls).toBe(1)
    expect(questionKeys).toEqual(["intent", "category", "subagent", "ambiguous"])
    expect([result.answers.intent, result.answers.category, result.answers.subagent]
      .every((answer) => answer.valid && answer.label === "would_apply")).toBe(true)
    expect(result.answers.ambiguous).toEqual({ noul: 0.1, valid: true })
    expect("label" in result.answers.ambiguous).toBe(false)
    expect(result).toMatchObject({ predictionStatus: "filled", invalidAnswerCount: 0,
      resolvedModel: "jev-resolved-v1", unavailableReason: null })
  })

  test("#given one choice below threshold #when deciding #then only that answer is labelled as falling through", async () => {
    const result = await decideIntentRouting({
      backend: createMockDecisionBackend(validAnswers(0.79)), input: { promptText: "Route me" },
      vocab: VALID_VOCAB, confidenceThreshold: 0.8, maxPromptChars: 200,
    })

    expect(result.answers.intent.label).toBe("would_apply")
    expect(result.answers.category.label).toBe("would_fall_through")
    expect(result.answers.subagent.label).toBe("would_apply")
  })

  test("#given an out-of-vocabulary choice #when deciding #then its raw value is retained and counted invalid", async () => {
    const answers = validAnswers()
    const result = await decideIntentRouting({
      backend: createRawBackend({ ...answers, intent: { ...answers.intent, choice: "outside" } }),
      input: { promptText: "Implement this" }, vocab: VALID_VOCAB,
      confidenceThreshold: 0.8, maxPromptChars: 200,
    })

    expect(result.answers.intent).toMatchObject({ choice: "outside", valid: false })
    expect(result.invalidAnswerCount).toBe(1)
    expect(result.predictionStatus).toBe("filled")
  })

  test("#given an unavailable backend #when deciding #then failure carries the unavailable reason", async () => {
    const result = await decideIntentRouting({
      backend: createUnavailableBackend("timeout"), input: { promptText: "Route me" },
      vocab: VALID_VOCAB, confidenceThreshold: 0.8, maxPromptChars: 200,
    })

    expect(result).toMatchObject({ predictionStatus: "failed", unavailableReason: "timeout",
      resolvedModel: null, invalidAnswerCount: 0 })
  })

  test("#given a rejecting backend #when deciding #then no exception escapes and transport failure is returned", async () => {
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        throw new TypeError("Connection failed")
      },
    }
    const operation = () => decideIntentRouting({
      backend, input: { promptText: "Route me" }, vocab: VALID_VOCAB,
      confidenceThreshold: 0.8, maxPromptChars: 200,
    })

    expect(operation).not.toThrow()
    await expect(operation()).resolves.toMatchObject({
      predictionStatus: "failed", unavailableReason: "transport_error",
    })
  })

  test("#given a prompt beyond the cap #when deciding #then state contains only bounded structured prompt data", async () => {
    let capturedState: DecisionState | undefined
    const delegate = createMockDecisionBackend(validAnswers())
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
        capturedState = request.state
        return delegate.decide(request)
      },
    }

    const result = await decideIntentRouting({
      backend, input: { promptText: "x".repeat(500) }, vocab: VALID_VOCAB,
      confidenceThreshold: 0.8, maxPromptChars: 12,
    })

    expect(result.truncatedInput).toBe(true)
    expect(capturedState).toEqual({ promptText: "x".repeat(12), truncatedInput: true })
  })
})
