// allow: SIZE_OK - the work plan requires the accuracy harness and its tests in one file.
import { describe, expect, test } from "bun:test"
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
import type { DecisionBackend, DecisionRequest } from "./types"

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
  const confusionMatrix = createMatrices()
  let decisionCallCount = 0
  let networkCallCount = 0
  let resolvedModel: string | null = null
  const counter: CallCounter = {
    read: () => decisionCallCount,
    increment: () => {
      decisionCallCount += 1
    },
  }
  const artifact = (status: "complete" | "partial", errorName: string | null): AccuracyArtifact => ({
    status,
    mode,
    resolvedModel,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    callCeiling,
    builtFixtureIds,
    completedFixtureIds,
    decisionCallCount,
    networkCallCount,
    errorName,
    confusionMatrix,
  })

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

    const backend = options.backendForFixture?.(fixture, index) ?? createFixtureMockBackend(fixture)
    if (backend.kind === "real") networkCallCount += 1
    const result = await decideIntentRouting({
      backend,
      input: fixture.input,
      vocab: VOCABULARY,
      confidenceThreshold: 0.8,
      model: request.model,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    if (result.predictionStatus !== "filled" || result.answers === null) {
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
      return artifact("partial", "IntentRoutingFixtureError")
    }
    addObservation(
      confusionMatrix.ambiguous,
      String(fixture.label.ambiguous),
      String(result.answers.ambiguous.noul >= 0.5),
    )
    resolvedModel = result.resolvedModel
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

  test.skipIf(!REAL_API_ENABLED || ACTIVE_MODE === "dry-run")("#given both real API gates #when every fixture is scored #then the paid run stays within the hard ceiling", async () => {
    const apiKey = Bun.env.TYPESAFE_API_KEY
    if (!apiKey || apiKey.trim() === "") throw new TypeError("TYPESAFE_API_KEY gate lost its value")
    const backend = selectDecisionBackend(
      { enabled: true, backend: "real", model: MODEL_ALIAS, timeoutMs: 2500 },
      { apiKey },
    )
    const artifact = await runAccuracyHarness({ mode: "real", backendForFixture: () => backend })
    console.info(`real-accuracy-artifact=${JSON.stringify(artifact)}`)

    expect(artifact.status).toBe("complete")
    expect(artifact.decisionCallCount).toBeLessThanOrEqual(CALL_CEILING)
    expect(artifact.networkCallCount).toBe(artifact.decisionCallCount)
    expect(artifact.resolvedModel).not.toBe(MODEL_ALIAS)
  })
})
