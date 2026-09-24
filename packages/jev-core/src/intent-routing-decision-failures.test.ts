import { describe, expect, test } from "bun:test"

import { isRecord } from "./answer-validation"
import {
  createTrackedBackend,
  decisionFunction,
  routingScript,
  type ExpectedDecisionResult,
} from "./intent-routing-decision-test-support"
import { vocabulary } from "./intent-routing-test-vocabulary"
import { createMockDecisionBackend } from "./mock-backend"
import type { DecisionBackend } from "./types"

describe("decideIntentRouting failures and boundaries", () => {
  test("#given an unavailable backend outcome #when deciding #then prediction fails and propagates the unavailable reason", async () => {
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

  test("#given a backend whose decide method rejects #when deciding #then prediction fails and no exception escapes", async () => {
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

  test("#given a prompt longer than maxPromptChars #when deciding #then structured state is bounded and truncatedInput is true", async () => {
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

  test("#given a disabled backend #when deciding #then it short-circuits without calling decide", async () => {
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
