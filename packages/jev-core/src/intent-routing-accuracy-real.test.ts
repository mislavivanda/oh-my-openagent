import { describe, expect, test } from "bun:test"
import type { Fetch } from "@typesafe-ai/sdk"

import { selectDecisionBackend } from "./backend-selector"
import {
  CALL_CEILING,
  IntentRoutingCallCeilingError,
  QUESTION_KEYS,
  realApiEnabled,
  resolveHarnessMode,
} from "./intent-routing-accuracy-contract"
import {
  buildAccuracyRequest,
  INTENT_ROUTING_FIXTURES,
  MODEL_ALIAS,
  QUESTIONS,
} from "./intent-routing-accuracy-fixtures"
import { runAccuracyHarness } from "./intent-routing-accuracy-harness"
import { INTENT_ROUTING_NONE_OPTION } from "./intent-routing"
import { choiceAnswer } from "./mock-backend"

const ACTIVE_MODE = resolveHarnessMode(Bun.argv)
const REAL_API_REQUESTED = Bun.env.JEV_W1_REAL_API === "1"
const REAL_API_ENABLED = realApiEnabled({
  JEV_W1_REAL_API: Bun.env.JEV_W1_REAL_API,
  TYPESAFE_API_KEY: Bun.env.TYPESAFE_API_KEY,
})

describe("intent-routing accuracy real backend paths", () => {
  test("#given real API configuration #when the gate is evaluated #then both the explicit flag and API key are required", () => {
    expect(realApiEnabled({ JEV_W1_REAL_API: "1", TYPESAFE_API_KEY: "test-key" })).toBe(true)
    expect(realApiEnabled({ JEV_W1_REAL_API: "1" })).toBe(false)
    expect(realApiEnabled({ TYPESAFE_API_KEY: "test-key" })).toBe(false)
  })

  test("#given one four-question call and a counting fetch #when the local stub answers #then one request carries measured usage and latency", async () => {
    let requestCount = 0
    const fetch: Fetch = async () => {
      requestCount += 1
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          intent: choiceAnswer("open-ended", 0.99, Object.keys(QUESTIONS.intent.criteria)),
          category: choiceAnswer(INTENT_ROUTING_NONE_OPTION, 0.99, Object.keys(QUESTIONS.category.criteria)),
          subagent: choiceAnswer(INTENT_ROUTING_NONE_OPTION, 0.99, Object.keys(QUESTIONS.subagent.criteria)),
          ambiguous: { type: "noul", noul: 0.01 },
        },
        usage: { input_tokens: 321, output_tokens: 7 },
      })
    }
    const backend = selectDecisionBackend(
      { enabled: true, backend: "real", model: MODEL_ALIAS, timeoutMs: 2500 },
      { apiKey: "local-measurement-key", fetch, baseURL: "https://jev.measurement.test" },
    )

    const outcome = await backend.decide(buildAccuracyRequest(INTENT_ROUTING_FIXTURES[0]))

    expect(outcome.status).toBe("decided")
    if (outcome.status !== "decided") throw new Error("Expected the local measurement to decide")
    expect(requestCount).toBe(1)
    expect(outcome.usage).toEqual({ input_tokens: 321, output_tokens: 7 })
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
    console.info(`request-count-measurement requests=${requestCount} questions=${QUESTION_KEYS.length} input-tokens=${outcome.usage.input_tokens} output-tokens=${outcome.usage.output_tokens} latency-ms=${outcome.latencyMs.toFixed(3)}`)
  })

  test("#given real mode without an API key #when all fixtures are evaluated #then every fixture is unavailable and zero requests are made", async () => {
    let requestCount = 0
    const backend = selectDecisionBackend(
      { enabled: true, backend: "real", model: MODEL_ALIAS, timeoutMs: 2500 },
      { apiKey: undefined, fetch: async () => { requestCount += 1; return Response.json({}) } },
    )

    const artifact = await runAccuracyHarness({ mode: "real", backendForFixture: () => backend })

    expect(artifact.status).toBe("complete")
    expect(artifact.decisionCallCount).toBe(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.networkCallCount).toBe(0)
    expect(requestCount).toBe(0)
    expect(Object.hasOwn(artifact, "unavailableReasonCounts")).toBe(true)
  })

  test.skipIf(!REAL_API_REQUESTED || ACTIVE_MODE === "dry-run")("#given the explicit real API gate #when every fixture is evaluated #then requests stay within the hard ceiling or missing credentials make zero requests", async () => {
    const apiKey = Bun.env.TYPESAFE_API_KEY
    let requestCount = 0
    const countingFetch: Fetch = async (input, init) => {
      if (requestCount >= CALL_CEILING) {
        throw new IntentRoutingCallCeilingError(CALL_CEILING, requestCount + 1)
      }
      requestCount += 1
      return fetch(input, init)
    }
    const backend = selectDecisionBackend(
      { enabled: true, backend: "real", model: MODEL_ALIAS, timeoutMs: 2500 },
      { apiKey, fetch: countingFetch },
    )
    const artifact = await runAccuracyHarness({
      mode: "real",
      backendForFixture: () => backend,
      requestCount: () => requestCount,
    })

    if (!apiKey || apiKey.trim() === "") {
      console.info(`missing-key-artifact=${JSON.stringify(artifact)}`)
      expect(artifact.status).toBe("complete")
      expect(artifact.decisionCallCount).toBe(INTENT_ROUTING_FIXTURES.length)
      expect(artifact.requestCount).toBe(0)
      expect(artifact.unavailableReasonCounts.missing_api_key).toBe(INTENT_ROUTING_FIXTURES.length)
      expect(artifact.fixtureResults.every((result) => result.unavailableReason === "missing_api_key")).toBe(true)
      return
    }

    console.info(`real-accuracy-artifact=${JSON.stringify(artifact)}`)

    expect(REAL_API_ENABLED).toBe(true)
    expect(artifact.status).toBe("complete")
    expect(artifact.decisionCallCount).toBeLessThanOrEqual(CALL_CEILING)
    expect(artifact.requestCount).toBeLessThanOrEqual(CALL_CEILING)
    expect(artifact.requestCount).toBe(artifact.decisionCallCount)
    expect(artifact.resolvedModel).not.toBe(MODEL_ALIAS)
    expect(artifact.fixtureResults).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.inputTokens).toBeGreaterThan(0)
    expect(artifact.latencyMs.min).not.toBeNull()
    expect(artifact.latencyMs.max).not.toBeNull()
  })
})
