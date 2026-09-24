// allow: SIZE_OK - the work plan requires the accuracy harness and its tests in one file.
import { describe, expect, test } from "bun:test"
import type { Fetch } from "@typesafe-ai/sdk"
import { selectDecisionBackend } from "./backend-selector"
import {
  INTENT_ROUTING_NONE_OPTION,
  INTENT_ROUTING_QUESTION_VERSION,
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import { decideIntentRouting } from "./intent-routing-decision"
import {
  INTENT_ROUTING_FIXTURES,
  INTENT_ROUTING_FIXTURE_CATEGORIES,
  INTENT_ROUTING_FIXTURE_INTENTS,
  type IntentRoutingFixture,
} from "./intent-routing-fixtures"
import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "./intent-routing-normalization"
import { choiceAnswer, createMockDecisionBackend, type MockDecisionScript } from "./mock-backend"
import type {
  DecisionBackend,
  DecisionRequest,
  DecisionUnavailableReason,
  DecisionUsage,
  Questions,
} from "./types"

const QUESTION_KEYS = ["intent", "category", "subagent", "ambiguous"] as const
const CHOICE_KEYS = ["intent", "category", "subagent"] as const
const CALL_CEILING = INTENT_ROUTING_FIXTURES.length
const MODEL_ALIAS = "jev-latest"
const MOCK_RESOLVED_MODEL = "mock/jev-intent-routing-v1"
const MAX_PROMPT_CHARS = 8000

type QuestionKey = (typeof QUESTION_KEYS)[number]
type HarnessMode = "mock" | "real" | "dry-run"
type ConfusionMatrix = Record<string, Record<string, number>>
type ConfusionMatrices = Record<QuestionKey, ConfusionMatrix>

type FixtureResult = {
  readonly id: string
  readonly status: "filled" | "unavailable" | "invalid"
  readonly resolvedModel: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly usage: DecisionUsage | null
  readonly latencyMs: number | null
}

type DecisionMeasurement = {
  readonly resolvedModel: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly usage: DecisionUsage | null
  readonly latencyMs: number
}

type AccuracyArtifact = {
  readonly status: "complete" | "partial"
  readonly mode: HarnessMode
  readonly resolvedModel: string | null
  readonly questionVersion: number
  readonly callCeiling: number
  readonly builtFixtureIds: readonly string[]
  readonly completedFixtureIds: readonly string[]
  readonly decisionCallCount: number
  readonly networkCallCount: number
  readonly requestCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: { readonly min: number | null; readonly max: number | null }
  readonly unavailableReasonCounts: Readonly<Partial<Record<DecisionUnavailableReason, number>>>
  readonly fixtureResults: readonly FixtureResult[]
  readonly errorName: string | null
  readonly confusionMatrix: ConfusionMatrices
}

type CallCounter = {
  readonly read: () => number
  readonly increment: () => void
}

type HarnessOptions = {
  readonly mode?: HarnessMode
  readonly callCeiling?: number
  readonly backendForFixture?: (fixture: IntentRoutingFixture, index: number) => DecisionBackend
  readonly requestCount?: () => number
}

class IntentRoutingCallCeilingError extends Error {
  constructor(
    readonly ceiling: number,
    readonly attemptedCall: number,
  ) {
    super(`intent-routing call ceiling ${ceiling} blocks call ${attemptedCall}`)
    this.name = "IntentRoutingCallCeilingError"
  }
}

class UnexpectedDryRunBackendCallError extends Error {
  constructor() {
    super("dry-run must not resolve or call a backend")
    this.name = "UnexpectedDryRunBackendCallError"
  }
}

const toEntries = (names: readonly string[]) =>
  names.map((name) => ({ name, description: `${name} routing option.` }))

const VOCABULARY = {
  categories: toEntries(INTENT_ROUTING_FIXTURE_CATEGORIES),
  subagents: toEntries(INTENT_ROUTING_SUBAGENT_VOCABULARY),
  intents: toEntries(INTENT_ROUTING_FIXTURE_INTENTS),
} satisfies IntentRoutingVocabulary

const QUESTIONS = buildIntentRoutingQuestions(VOCABULARY)

function resolveHarnessMode(argv: readonly string[]): HarnessMode {
  return argv.includes("--dry-run") ? "dry-run" : "mock"
}

function realApiEnabled(env: {
  readonly JEV_W1_REAL_API?: string
  readonly TYPESAFE_API_KEY?: string
}): boolean {
  return env.JEV_W1_REAL_API === "1" && Boolean(env.TYPESAFE_API_KEY?.trim())
}

function consumeCall(ceiling: number, counter: CallCounter): void {
  const completedCalls = counter.read()
  if (completedCalls >= ceiling) {
    throw new IntentRoutingCallCeilingError(ceiling, completedCalls + 1)
  }
  counter.increment()
}

function createMatrices(): ConfusionMatrices {
  return { intent: {}, category: {}, subagent: {}, ambiguous: {} }
}

function createMeasuredBackend(
  backend: DecisionBackend,
  measurements: DecisionMeasurement[],
): DecisionBackend {
  return {
    kind: backend.kind,
    async decide<Q extends Questions>(request: DecisionRequest<Q>) {
      const outcome = await backend.decide(request)
      measurements.push(
        outcome.status === "decided"
          ? {
              resolvedModel: outcome.model,
              unavailableReason: null,
              usage: outcome.usage,
              latencyMs: outcome.latencyMs,
            }
          : {
              resolvedModel: null,
              unavailableReason: outcome.reason,
              usage: null,
              latencyMs: outcome.latencyMs,
            },
      )
      return outcome
    },
  }
}

function addObservation(matrix: ConfusionMatrix, expected: string, predicted: string): void {
  const row = matrix[expected] ?? {}
  row[predicted] = (row[predicted] ?? 0) + 1
  matrix[expected] = row
}

function buildAccuracyRequest(
  fixture: IntentRoutingFixture,
): DecisionRequest<typeof QUESTIONS> {
  if (
    !(fixture.label.intent in QUESTIONS.intent.criteria) ||
    !(fixture.label.category in QUESTIONS.category.criteria) ||
    !(fixture.label.subagent in QUESTIONS.subagent.criteria)
  ) {
    throw new TypeError(`fixture ${fixture.id} has a label outside the question vocabulary`)
  }
  return {
    state: { promptText: fixture.input.promptText, truncatedInput: false },
    questions: QUESTIONS,
    model: MODEL_ALIAS,
  }
}

function createFixtureMockBackend(fixture: IntentRoutingFixture): DecisionBackend {
  const script: MockDecisionScript = {
    intent: choiceAnswer(fixture.label.intent, 0.99, Object.keys(QUESTIONS.intent.criteria)),
    category: choiceAnswer(fixture.label.category, 0.99, Object.keys(QUESTIONS.category.criteria)),
    subagent: choiceAnswer(fixture.label.subagent, 0.99, Object.keys(QUESTIONS.subagent.criteria)),
    ambiguous: { type: "noul", noul: fixture.label.ambiguous ? 0.99 : 0.01 },
  }
  return createMockDecisionBackend(script, { model: MOCK_RESOLVED_MODEL })
}

async function runAccuracyHarness(options: HarnessOptions = {}): Promise<AccuracyArtifact> {
  const mode = options.mode ?? resolveHarnessMode(Bun.argv)
  const callCeiling = options.callCeiling ?? CALL_CEILING
  const builtFixtureIds: string[] = []
  const completedFixtureIds: string[] = []
  const fixtureResults: FixtureResult[] = []
  const measurements: DecisionMeasurement[] = []
  const unavailableReasonCounts: Partial<Record<DecisionUnavailableReason, number>> = {}
  const confusionMatrix = createMatrices()
  let decisionCallCount = 0
  let resolvedModel: string | null = null
  const counter: CallCounter = {
    read: () => decisionCallCount,
    increment: () => {
      decisionCallCount += 1
    },
  }
  const artifact = (status: "complete" | "partial", errorName: string | null): AccuracyArtifact => {
    const latencies = measurements.map((measurement) => measurement.latencyMs)
    const requestCount = options.requestCount?.() ?? 0
    return {
      status,
      mode,
      resolvedModel,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
      callCeiling,
      builtFixtureIds,
      completedFixtureIds,
      decisionCallCount,
      networkCallCount: requestCount,
      requestCount,
      inputTokens: measurements.reduce(
        (total, measurement) => total + (measurement.usage?.input_tokens ?? 0),
        0,
      ),
      outputTokens: measurements.reduce(
        (total, measurement) => total + (measurement.usage?.output_tokens ?? 0),
        0,
      ),
      latencyMs: {
        min: latencies.length === 0 ? null : Math.min(...latencies),
        max: latencies.length === 0 ? null : Math.max(...latencies),
      },
      unavailableReasonCounts,
      fixtureResults,
      errorName,
      confusionMatrix,
    }
  }

  for (const [index, fixture] of INTENT_ROUTING_FIXTURES.entries()) {
    const request = buildAccuracyRequest(fixture)
    JSON.stringify(request)
    builtFixtureIds.push(fixture.id)
    if (mode === "dry-run") continue

    try {
      consumeCall(callCeiling, counter)
    } catch (error) {
      if (error instanceof IntentRoutingCallCeilingError) return artifact("partial", error.name)
      throw error
    }

    const backend = createMeasuredBackend(
      options.backendForFixture?.(fixture, index) ?? createFixtureMockBackend(fixture),
      measurements,
    )
    const result = await decideIntentRouting({
      backend,
      input: fixture.input,
      vocab: VOCABULARY,
      confidenceThreshold: 0.8,
      model: request.model,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    if (result.predictionStatus !== "filled" || result.answers === null) {
      const measurement = measurements.at(-1)
      const unavailableReason = result.unavailableReason
      fixtureResults.push({
        id: fixture.id,
        status: "unavailable",
        resolvedModel: null,
        unavailableReason,
        usage: measurement?.usage ?? null,
        latencyMs: result.latencyMs,
      })
      if (unavailableReason !== null) {
        unavailableReasonCounts[unavailableReason] = (unavailableReasonCounts[unavailableReason] ?? 0) + 1
      }
      if (unavailableReason === "missing_api_key") continue
      return artifact("partial", "IntentRoutingFixtureError")
    }

    let valid = true
    for (const key of CHOICE_KEYS) {
      const answer = result.answers[key]
      if (!answer.valid) {
        valid = false
        break
      }
      addObservation(confusionMatrix[key], fixture.label[key], answer.choice)
    }
    if (!valid || !result.answers.ambiguous.valid) {
      const measurement = measurements.at(-1)
      fixtureResults.push({
        id: fixture.id,
        status: "invalid",
        resolvedModel: result.resolvedModel,
        unavailableReason: null,
        usage: measurement?.usage ?? null,
        latencyMs: result.latencyMs,
      })
      return artifact("partial", "IntentRoutingFixtureError")
    }
    addObservation(
      confusionMatrix.ambiguous,
      String(fixture.label.ambiguous),
      String(result.answers.ambiguous.noul >= 0.5),
    )
    resolvedModel = result.resolvedModel
    const measurement = measurements.at(-1)
    fixtureResults.push({
      id: fixture.id,
      status: "filled",
      resolvedModel: result.resolvedModel,
      unavailableReason: null,
      usage: measurement?.usage ?? null,
      latencyMs: result.latencyMs,
    })
    completedFixtureIds.push(fixture.id)
  }
  return artifact("complete", null)
}

function matrixTotal(matrix: ConfusionMatrix): number {
  return Object.values(matrix).reduce(
    (total, row) => total + Object.values(row).reduce((rowTotal, count) => rowTotal + count, 0),
    0,
  )
}

const ACTIVE_MODE = resolveHarnessMode(Bun.argv)
const REAL_API_REQUESTED = Bun.env.JEV_W1_REAL_API === "1"
const REAL_API_ENABLED = realApiEnabled({
  JEV_W1_REAL_API: Bun.env.JEV_W1_REAL_API,
  TYPESAFE_API_KEY: Bun.env.TYPESAFE_API_KEY,
})

describe("intent-routing accuracy harness", () => {
  test.skipIf(ACTIVE_MODE === "dry-run")("#given the default mock path #when every fixture is scored #then every question emits a complete confusion matrix with zero network calls", async () => {
    const artifact = await runAccuracyHarness()
    console.info(`mock-accuracy-artifact=${JSON.stringify(artifact)}`)
    console.info(`zero-network-calls=${artifact.networkCallCount}`)

    expect(artifact.status).toBe("complete")
    expect(artifact.completedFixtureIds).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.decisionCallCount).toBe(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.networkCallCount).toBe(0)
    expect(artifact.resolvedModel).toBe(MOCK_RESOLVED_MODEL)
    expect(Object.hasOwn(artifact, "resolvedModel")).toBe(true)
    expect(Object.hasOwn(artifact, "questionVersion")).toBe(true)
    for (const question of QUESTION_KEYS) {
      expect(matrixTotal(artifact.confusionMatrix[question])).toBe(INTENT_ROUTING_FIXTURES.length)
    }
  })

  test("#given --dry-run #when every fixture request is built #then no backend or network call is made", async () => {
    const artifact = await runAccuracyHarness({
      mode: "dry-run",
      backendForFixture: () => {
        throw new UnexpectedDryRunBackendCallError()
      },
    })
    console.info(`dry-run built=${artifact.builtFixtureIds.length} decision-calls=${artifact.decisionCallCount} network-calls=${artifact.networkCallCount}`)

    expect(resolveHarnessMode(["bun", "test", "--dry-run"])).toBe("dry-run")
    expect(artifact.status).toBe("complete")
    expect(artifact.builtFixtureIds).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.decisionCallCount).toBe(0)
    expect(artifact.networkCallCount).toBe(0)
  })

  test("#given a stub counter one below the ceiling #when two calls are requested #then the second aborts with the named ceiling error", () => {
    let calls = CALL_CEILING - 1
    const counter: CallCounter = {
      read: () => calls,
      increment: () => {
        calls += 1
      },
    }
    consumeCall(CALL_CEILING, counter)

    let thrown: IntentRoutingCallCeilingError | undefined
    try {
      consumeCall(CALL_CEILING, counter)
    } catch (error) {
      if (error instanceof IntentRoutingCallCeilingError) thrown = error
      else throw error
    }

    expect(thrown).toBeInstanceOf(IntentRoutingCallCeilingError)
    expect(thrown?.name).toBe("IntentRoutingCallCeilingError")
    expect(calls).toBe(CALL_CEILING)
    console.info(`ceiling-abort-proof ceiling=${CALL_CEILING} calls=${calls} error=IntentRoutingCallCeilingError`)
  })

  test("#given a failure at fixture 8 #when the run stops #then a partial artifact retains the first 7 fixture ids", async () => {
    const artifact = await runAccuracyHarness({
      mode: "mock",
      backendForFixture: (fixture, index) =>
        index === 7
          ? { kind: "mock", decide: async () => ({ status: "unavailable", reason: "api_error", latencyMs: 1 }) }
          : createFixtureMockBackend(fixture),
    })
    console.info(`partial-accuracy-artifact=${JSON.stringify(artifact)}`)

    expect(artifact.status).toBe("partial")
    expect(artifact.errorName).toBe("IntentRoutingFixtureError")
    expect(artifact.completedFixtureIds).toEqual(INTENT_ROUTING_FIXTURES.slice(0, 7).map((fixture) => fixture.id))
    expect(artifact.decisionCallCount).toBe(8)
  })

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
