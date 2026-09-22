import { describe, expect, test } from "bun:test"
import {
  MODEL_ERROR_TRIAGE_FIXTURES,
  MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE,
  type ModelErrorTriageFixture,
} from "./model-error-triage-fixtures"
import {
  MODEL_ERROR_MESSAGE_MAX_CHARS,
  buildModelErrorTriageState,
  decideModelErrorTriage,
} from "./model-error-triage"
import { choiceAnswer, createMockDecisionBackend } from "./mock-backend"
import type {
  DecisionBackend,
  DecisionOutcome,
  DecisionUnavailableReason,
  Questions,
} from "./types"

const TRIAGE_CHOICES = ["retry", "stop", "ignore"] as const

const DECISION_UNAVAILABLE_REASONS = [
  "disabled",
  "missing_api_key",
  "timeout",
  "transport_error",
  "api_error",
  "malformed_response",
  "unscripted",
  "not_implemented",
] as const satisfies readonly DecisionUnavailableReason[]

type MissingDecisionUnavailableReason = Exclude<
  DecisionUnavailableReason,
  (typeof DECISION_UNAVAILABLE_REASONS)[number]
>
const allDecisionUnavailableReasonsCovered: MissingDecisionUnavailableReason extends never
  ? true
  : never = true
void allDecisionUnavailableReasonsCovered

function findFixture(
  predicate: (fixture: ModelErrorTriageFixture) => boolean,
): ModelErrorTriageFixture {
  const fixture = MODEL_ERROR_TRIAGE_FIXTURES.find(predicate)
  if (!fixture) {
    throw new TypeError("Expected a matching model-error triage fixture")
  }
  return fixture
}

function createUnavailableBackend(reason: DecisionUnavailableReason): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return { status: "unavailable", reason, latencyMs: 0 }
    },
  }
}

describe("decideModelErrorTriage", () => {
  test("#given case (1) a retryable fixture and confident ignore #when deciding #then jev prevents retry", async () => {
    const fixture = findFixture((candidate) => candidate.heuristicShouldRetry)
    const backend = createMockDecisionBackend(
      { triage: choiceAnswer("ignore", 0.95, TRIAGE_CHOICES) },
      { model: "mock-jev" },
    )

    const result = await decideModelErrorTriage({
      backend,
      input: fixture.input,
      heuristic: () => fixture.heuristicShouldRetry,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: false,
      source: "jev",
      heuristicShouldRetry: true,
      threshold: 0.8,
      questionVersion: 1,
      jev: { choice: "ignore", confidence: 0.95, model: "mock-jev" },
    })
  })

  test("#given case (2) a non-retryable fixture and confident retry #when deciding #then jev enables retry", async () => {
    const fixture = findFixture((candidate) => !candidate.heuristicShouldRetry)
    const backend = createMockDecisionBackend({
      triage: choiceAnswer("retry", 0.95, TRIAGE_CHOICES),
    })

    const result = await decideModelErrorTriage({
      backend,
      input: fixture.input,
      heuristic: () => fixture.heuristicShouldRetry,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: true,
      source: "jev",
      heuristicShouldRetry: false,
      jev: { choice: "retry", confidence: 0.95 },
    })
  })

  test("#given case (3) confidence 0.79 and threshold 0.8 #when deciding #then the populated jev result falls through", async () => {
    const fixture = findFixture((candidate) => candidate.heuristicShouldRetry)
    const backend = createMockDecisionBackend({
      triage: choiceAnswer("ignore", 0.79, TRIAGE_CHOICES),
    })

    const result = await decideModelErrorTriage({
      backend,
      input: fixture.input,
      heuristic: () => fixture.heuristicShouldRetry,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: true,
      source: "heuristic",
      heuristicShouldRetry: true,
      fellThroughReason: "low_confidence",
      jev: { choice: "ignore", confidence: 0.79 },
    })
  })

  test("#given case (4) an unscripted mock #when deciding #then the heuristic answer and reason are returned", async () => {
    const result = await decideModelErrorTriage({
      backend: createMockDecisionBackend({}),
      input: { message: "unclassified provider response" },
      heuristic: () => true,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: true,
      source: "heuristic",
      heuristicShouldRetry: true,
      fellThroughReason: "unscripted",
    })
  })

  test("#given case (5) a disabled backend #when deciding #then decide is never called and the heuristic is returned", async () => {
    let decideCalls = 0
    const backend: DecisionBackend = {
      kind: "disabled",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        decideCalls += 1
        throw new TypeError("Disabled backend decide must not be called")
      },
    }

    const result = await decideModelErrorTriage({
      backend,
      input: { name: "ratelimiterror" },
      heuristic: () => true,
      confidenceThreshold: 0.8,
    })

    expect(decideCalls).toBe(0)
    expect(result).toMatchObject({
      shouldRetry: true,
      source: "heuristic",
      heuristicShouldRetry: true,
      fellThroughReason: "disabled",
    })
  })

  test("#given case (6) a rejecting backend #when deciding #then transport error falls through to the heuristic", async () => {
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        throw new TypeError("Connection failed")
      },
    }

    const result = await decideModelErrorTriage({
      backend,
      input: { message: "unclassified provider response" },
      heuristic: () => false,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: false,
      source: "heuristic",
      heuristicShouldRetry: false,
      fellThroughReason: "transport_error",
    })
  })

  test("#given case (7) a 5000-character message and missing fields #when building state #then the message is capped and missing fields are null", () => {
    const state = buildModelErrorTriageState({ message: "x".repeat(5000) })

    expect(state).toEqual({
      error_name: null,
      error_message: "x".repeat(MODEL_ERROR_MESSAGE_MAX_CHARS),
      status_code: null,
    })
    expect(state.error_message).toHaveLength(2000)
  })

  test("#given case (8) confident stop #when deciding #then retry is disabled", async () => {
    const backend = createMockDecisionBackend({
      triage: choiceAnswer("stop", 0.95, TRIAGE_CHOICES),
    })

    const result = await decideModelErrorTriage({
      backend,
      input: { message: "quota exceeded" },
      heuristic: () => true,
      confidenceThreshold: 0.8,
    })

    expect(result).toMatchObject({
      shouldRetry: false,
      source: "jev",
      heuristicShouldRetry: true,
      jev: { choice: "stop", confidence: 0.95 },
    })
  })

  test("#given case (9) every labeled fixture #when checking consistency #then heuristic and source labels agree", () => {
    for (const fixture of MODEL_ERROR_TRIAGE_FIXTURES) {
      expect(fixture.heuristicShouldRetry).toBe(fixture.label === "retry")
      expect(fixture.label).toBe(MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE[fixture.source])
    }
  })

  test("#given case (10) all fixture ids #when checking uniqueness #then no id is repeated", () => {
    const ids = MODEL_ERROR_TRIAGE_FIXTURES.map((fixture) => fixture.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  test.each([...DECISION_UNAVAILABLE_REASONS])(
    "#given case (11) unavailable reason %s #when deciding with true and false heuristics #then each answer and reason fall through",
    async (reason) => {
      for (const heuristicShouldRetry of [true, false] as const) {
        const result = await decideModelErrorTriage({
          backend: createUnavailableBackend(reason),
          input: { message: "unclassified provider response" },
          heuristic: () => heuristicShouldRetry,
          confidenceThreshold: 0.8,
        })

        expect(result).toMatchObject({
          shouldRetry: heuristicShouldRetry,
          source: "heuristic",
          heuristicShouldRetry,
          fellThroughReason: reason,
        })
      }
    },
  )
})
