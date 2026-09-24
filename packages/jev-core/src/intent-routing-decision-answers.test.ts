import { describe, expect, test } from "bun:test"

import { INTENT_ROUTING_QUESTION_VERSION } from "./intent-routing"
import {
  createCorruptingMock,
  createTrackedBackend,
  decisionFunction,
  requireAnswers,
  routingScript,
} from "./intent-routing-decision-test-support"
import { vocabulary } from "./intent-routing-test-vocabulary"
import { createMockDecisionBackend } from "./mock-backend"

describe("decideIntentRouting answers", () => {
  test("#given valid answers above the confidence threshold #when deciding all four questions #then choice answers are labelled would_apply and ambiguous has no confidence or label", async () => {
    const tracked = createTrackedBackend(
      createMockDecisionBackend(routingScript(), { model: "jev-2026-09-24" }),
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

  test("#given one answer below the confidence threshold #when deciding #then only that question is labelled would_fall_through without gating the result", async () => {
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

  test("#given a choice outside the option set #when deciding #then the raw choice is retained marked invalid and counted", async () => {
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

  test("#given a decided outcome missing one question key #when deciding #then missing raw fields remain explicit undefined values and count as invalid", async () => {
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
