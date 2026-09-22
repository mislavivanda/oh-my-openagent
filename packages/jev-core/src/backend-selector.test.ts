import { describe, expect, test } from "bun:test"
import {
  selectDecisionBackend,
  type DecisionBackendConfig,
  type DecisionBackendDeps,
} from "./backend-selector"
import type { DecisionBackendKind, Questions } from "./types"

const MODEL = "jev-1.13.0"
const QUESTIONS = {} satisfies Questions

const ENABLED_BACKEND_CASES = [
  ["mock", "mock"],
  ["llm-adapter", "llm-adapter"],
  ["real", "real"],
] as const satisfies readonly (readonly [DecisionBackendKind, DecisionBackendKind])[]

function enabledConfig(backend: DecisionBackendKind): DecisionBackendConfig {
  return { enabled: true, backend, model: MODEL, timeoutMs: 1_000 }
}

describe("selectDecisionBackend", () => {
  test.each(ENABLED_BACKEND_CASES)(
    "#given enabled backend %s #when selecting #then its kind is %s",
    (backendKind, expectedKind) => {
      const backend = selectDecisionBackend(enabledConfig(backendKind))

      expect(backend.kind).toBe(expectedKind)
    },
  )

  test("#given disabled configuration for the real backend #when selecting and deciding #then disabled wins without fetching", async () => {
    let fetchCalls = 0
    const fetch: NonNullable<DecisionBackendDeps["fetch"]> = async () => {
      fetchCalls += 1
      return new Response("{}")
    }
    const backend = selectDecisionBackend(
      { ...enabledConfig("real"), enabled: false },
      { apiKey: "jev-test-key", fetch },
    )

    const outcome = await backend.decide({ state: null, questions: QUESTIONS })

    expect(backend.kind).toBe("disabled")
    expect(outcome).toMatchObject({ status: "unavailable", reason: "disabled" })
    expect(fetchCalls).toBe(0)
  })

  test("#given an enabled real backend without an API key #when deciding #then it is unavailable with missing_api_key", async () => {
    const backend = selectDecisionBackend(enabledConfig("real"))

    const outcome = await backend.decide({ state: null, questions: QUESTIONS })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "missing_api_key" })
  })

  test("#given the llm-adapter placeholder #when deciding #then it is unavailable with not_implemented", async () => {
    const backend = selectDecisionBackend(enabledConfig("llm-adapter"))

    const outcome = await backend.decide({ state: null, questions: QUESTIONS })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "not_implemented" })
  })
})
