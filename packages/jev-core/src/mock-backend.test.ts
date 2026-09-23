import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../test-support/unsafe-test-value"
import { choiceAnswer, createMockDecisionBackend } from "./mock-backend"
import type { ChoiceAnswer, Questions } from "./types"

const questions = {
  triage: {
    type: "choice",
    instructions: "Choose the next action",
    criteria: {
      retry: "Try again",
      stop: "Do not retry",
      ignore: "Continue without retrying",
    },
  },
} satisfies Questions

describe("createMockDecisionBackend", () => {
  test("#given a scripted answer #when deciding #then it is returned under the same id", async () => {
    const answer = choiceAnswer("retry", 0.9, ["retry", "stop", "ignore"])
    const backend = createMockDecisionBackend({ triage: answer })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome.status).toBe("decided")
    if (outcome.status !== "decided") {
      throw new Error("Expected a decided mock outcome")
    }
    expect(outcome.answers.triage).toBe(answer)
  })

  test("#given an unscripted id #when deciding #then it is unavailable with reason unscripted", async () => {
    const backend = createMockDecisionBackend({})

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "unscripted", detail: "triage" })
  })

  test("#given a noul answer for a choice question #when deciding #then the type mismatch is unscripted", async () => {
    const backend = createMockDecisionBackend({ triage: { type: "noul", noul: 0.5 } })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "unscripted", detail: "triage" })
  })

  test("#given a scripted unknown choice #when deciding #then the fixture is unscripted", async () => {
    const answer = unsafeTestValue<ChoiceAnswer<"retry" | "stop" | "ignore">>({
      type: "choice",
      choice: "later",
      confidence: 0.9,
      probabilities: { retry: 0.9, stop: 0.05, ignore: 0.05 },
    })
    const backend = createMockDecisionBackend({ triage: answer })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "unscripted", detail: "triage" })
  })

  test("#given a scripted choice missing one probability key #when deciding #then the fixture is unscripted", async () => {
    const answer = unsafeTestValue<ChoiceAnswer<"retry" | "stop" | "ignore">>({
      type: "choice",
      choice: "retry",
      confidence: 0.9,
      probabilities: { retry: 0.9, stop: 0.1 },
    })
    const backend = createMockDecisionBackend({ triage: answer })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "unscripted", detail: "triage" })
  })

  test("#given retry at 0.9 and three options #when building choiceAnswer probabilities #then they sum to one", () => {
    const answer = choiceAnswer("retry", 0.9, ["retry", "stop", "ignore"])
    const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0)

    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-9)
    expect(answer.probabilities.retry).toBe(0.9)
  })

  test("#given a scripted decision #when deciding #then latencyMs is non-negative", async () => {
    const backend = createMockDecisionBackend({
      triage: choiceAnswer("retry", 0.9, ["retry", "stop", "ignore"]),
    })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
  })
})
