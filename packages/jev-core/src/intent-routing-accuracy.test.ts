import { describe, expect, test } from "bun:test"
import type { Fetch } from "@typesafe-ai/sdk"
import {
  INTENT_ROUTING_FIXTURES,
  type IntentRoutingFixture,
  type IntentRoutingFixtureIntent,
} from "./intent-routing-fixtures"
import {
  INTENT_ROUTING_CATEGORY_VOCABULARY,
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
} from "./intent-routing-normalization"
import {
  INTENT_ROUTING_QUESTION_VERSION,
  buildIntentRoutingQuestions,
  decideIntentRouting,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import type { IntentRoutingAnswers } from "./intent-routing-record"
import { choiceAnswer, createMockDecisionBackend } from "./mock-backend"
import { createRealDecisionBackend } from "./real-backend"
import type { DecisionBackend } from "./types"

// allow: SIZE_OK - todo 8 requires the runner, harness, and tests in one test file.
const QUESTION_IDS = ["intent", "category", "subagent", "ambiguous"] as const
const DIRECT_DRY_RUN = process.argv.includes("--dry-run")
const REQUESTED_MODEL = process.env.JEV_W1_MODEL ?? "jev-latest"
const MOCK_RESOLVED_MODEL = "mock/jev-intent-routing-v1"
const CONFIDENCE_THRESHOLD = 0.8
const MAX_PROMPT_CHARS = 2_000
type QuestionId = (typeof QUESTION_IDS)[number]
type RunMode = "dry-run" | "mock" | "real"
type CallCounter = { calls: number }
type MutableMatrices = Record<QuestionId, Record<string, Record<string, number>>>
type FixtureResult = {
  readonly fixtureId: string
  readonly expected: Readonly<Record<QuestionId, string>>
  readonly predicted: Readonly<Record<QuestionId, string>>
  readonly exact: boolean
}
type RunMetrics = {
  inputTokens: number
  outputTokens: number
  readonly latencies: number[]
}
type AccuracyArtifact = {
  readonly status: "complete" | "partial"
  readonly mode: RunMode
  readonly requestedModel: string
  readonly resolvedModel: string | null
  readonly questionVersion: number
  readonly callCount: number
  readonly networkCallCount: number
  readonly builtRequestCount: number
  readonly completedFixtureIds: readonly string[]
  readonly fixtureExactMatches: number
  readonly correctAnswers: number
  readonly scoredAnswers: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: { readonly min: number; readonly max: number } | null
  readonly fixtureResults: readonly FixtureResult[]
  readonly unavailableFixtures: readonly { readonly fixtureId: string; readonly reason: string }[]
  readonly confusionMatrices: MutableMatrices
  readonly failure: { readonly name: string; readonly fixtureId: string } | null
}
type HarnessState = {
  resolvedModel: string | null
  builtRequestCount: number
  fixtureExactMatches: number
  correctAnswers: number
  scoredAnswers: number
  readonly completedFixtureIds: string[]
  readonly fixtureResults: FixtureResult[]
  readonly unavailableFixtures: { fixtureId: string; reason: string }[]
  readonly confusionMatrices: MutableMatrices
}
type HarnessOptions = {
  readonly mode: "mock" | "real"
  readonly fixtures: readonly IntentRoutingFixture[]
  readonly backendForFixture: (fixture: IntentRoutingFixture) => DecisionBackend
  readonly callCounter: CallCounter
  readonly networkCounter: CallCounter
  readonly maxCalls: number
  readonly emit: (artifact: AccuracyArtifact) => void
  readonly metrics?: RunMetrics
}
type ArtifactRuntime = {
  readonly mode: RunMode
  readonly callCounter: CallCounter
  readonly networkCounter: CallCounter
  readonly metrics?: RunMetrics
}
type ArtifactCompletion = {
  readonly status: "complete" | "partial"
  readonly failure: AccuracyArtifact["failure"]
}

const INTENT_DESCRIPTION_BY_LABEL: Readonly<Record<IntentRoutingFixtureIntent, string>> = {
  implement: "Implement or modify a requested behavior.",
  investigate: "Investigate a failure, cause, or code path.",
  explain: "Explain a system, behavior, or concept.",
  review: "Review existing work or a proposed change.",
  author: "Author prose, documentation, or communication.",
  acknowledge: "Acknowledge without requesting further work.",
  continue: "Continue the prior task or conversation.",
}
const fixtureIntentLabels = [...new Set(INTENT_ROUTING_FIXTURES.map((fixture) => fixture.label.intent))]
const HARNESS_VOCABULARY: IntentRoutingVocabulary = {
  categories: INTENT_ROUTING_CATEGORY_VOCABULARY.map((name) => ({ name, description: name })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY.map((name) => ({ name, description: name })),
  intents: fixtureIntentLabels.map((name) => ({ name, description: INTENT_DESCRIPTION_BY_LABEL[name] })),
}
const QUESTIONS = buildIntentRoutingQuestions(HARNESS_VOCABULARY)
const INTENT_OPTIONS = Object.keys(QUESTIONS.intent.criteria)
const CATEGORY_OPTIONS = Object.keys(QUESTIONS.category.criteria)
const SUBAGENT_OPTIONS = Object.keys(QUESTIONS.subagent.criteria)

class IntentRoutingCallCeilingError extends Error {
  override readonly name = "IntentRoutingCallCeilingError"
  constructor(readonly limit: number) {
    super(`Intent-routing accuracy call ceiling ${limit} reached`)
  }
}
class IntentRoutingAccuracyRunError extends Error {
  override readonly name = "IntentRoutingAccuracyRunError"
  constructor(readonly fixtureId: string, reason: string) {
    super(`Intent-routing accuracy failed for ${fixtureId}: ${reason}`)
  }
}
class IntentRoutingFixtureValidationError extends Error {
  override readonly name = "IntentRoutingFixtureValidationError"
}

function selectRunMode(env: Readonly<Record<string, string | undefined>>, dryRun: boolean): RunMode {
  if (dryRun) return "dry-run"
  return env.JEV_W1_REAL_API === "1" ? "real" : "mock"
}
function emptyMetrics(): RunMetrics {
  return { inputTokens: 0, outputTokens: 0, latencies: [] }
}
function emptyMatrices(): MutableMatrices {
  return { intent: {}, category: {}, subagent: {}, ambiguous: {} }
}
function validateFixture(fixture: IntentRoutingFixture): void {
  const valid = fixture.id.length > 0 && fixture.input.promptText.length > 0 &&
    fixture.label.intent in QUESTIONS.intent.criteria &&
    fixture.label.category in QUESTIONS.category.criteria &&
    fixture.label.subagent in QUESTIONS.subagent.criteria &&
    fixture.label.ambiguous >= 0 && fixture.label.ambiguous <= 1
  if (!valid) throw new IntentRoutingFixtureValidationError(`Invalid intent-routing fixture: ${fixture.id}`)
}
function createMockBackend(fixture: IntentRoutingFixture): DecisionBackend {
  return createMockDecisionBackend({
    intent: choiceAnswer(fixture.label.intent, 0.95, INTENT_OPTIONS),
    category: choiceAnswer(fixture.label.category, 0.95, CATEGORY_OPTIONS),
    subagent: choiceAnswer(fixture.label.subagent, 0.95, SUBAGENT_OPTIONS),
    ambiguous: { type: "noul", noul: fixture.label.ambiguous },
  }, { model: MOCK_RESOLVED_MODEL })
}
function createArtifact(
  runtime: ArtifactRuntime,
  state: HarnessState,
  completion: ArtifactCompletion,
): AccuracyArtifact {
  const metrics = runtime.metrics ?? emptyMetrics()
  return {
    status: completion.status,
    mode: runtime.mode,
    requestedModel: REQUESTED_MODEL,
    resolvedModel: state.resolvedModel,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    callCount: runtime.callCounter.calls,
    networkCallCount: runtime.networkCounter.calls,
    builtRequestCount: state.builtRequestCount,
    completedFixtureIds: [...state.completedFixtureIds],
    fixtureExactMatches: state.fixtureExactMatches,
    correctAnswers: state.correctAnswers,
    scoredAnswers: state.scoredAnswers,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs: metrics.latencies.length === 0
      ? null
      : { min: Math.min(...metrics.latencies), max: Math.max(...metrics.latencies) },
    fixtureResults: structuredClone(state.fixtureResults),
    unavailableFixtures: structuredClone(state.unavailableFixtures),
    confusionMatrices: structuredClone(state.confusionMatrices),
    failure: completion.failure,
  }
}
function createMeasuredBackend(backend: DecisionBackend, metrics: RunMetrics): DecisionBackend {
  return {
    kind: backend.kind,
    async decide(request) {
      const outcome = await backend.decide(request)
      metrics.latencies.push(outcome.latencyMs)
      if (outcome.status === "decided") {
        metrics.inputTokens += outcome.usage.input_tokens
        metrics.outputTokens += outcome.usage.output_tokens
      }
      return outcome
    },
  }
}
function recordScore(state: HarnessState, fixture: IntentRoutingFixture, answers: IntentRoutingAnswers): void {
  const expected: Record<QuestionId, string> = {
    intent: fixture.label.intent,
    category: fixture.label.category,
    subagent: fixture.label.subagent,
    ambiguous: fixture.label.ambiguous >= 0.5 ? "true" : "false",
  }
  const predicted: Record<QuestionId, string> = {
    intent: answers.intent.choice,
    category: answers.category.choice,
    subagent: answers.subagent.choice,
    ambiguous: answers.ambiguous.noul >= 0.5 ? "true" : "false",
  }
  let exact = true
  for (const questionId of QUESTION_IDS) {
    const actual = expected[questionId]
    const prediction = predicted[questionId]
    const row = state.confusionMatrices[questionId][actual] ?? {}
    row[prediction] = (row[prediction] ?? 0) + 1
    state.confusionMatrices[questionId][actual] = row
    if (actual === prediction) state.correctAnswers += 1
    else exact = false
  }
  state.fixtureResults.push({ fixtureId: fixture.id, expected, predicted, exact })
  if (exact) state.fixtureExactMatches += 1
  state.scoredAnswers += QUESTION_IDS.length
  state.completedFixtureIds.push(fixture.id)
}
function runDryRun(calls: CallCounter, networkCalls: CallCounter): AccuracyArtifact {
  const state: HarnessState = {
    resolvedModel: null,
    builtRequestCount: 0,
    fixtureExactMatches: 0,
    correctAnswers: 0,
    scoredAnswers: 0,
    completedFixtureIds: [],
    fixtureResults: [],
    unavailableFixtures: [],
    confusionMatrices: emptyMatrices(),
  }
  for (const fixture of INTENT_ROUTING_FIXTURES) {
    validateFixture(fixture)
    const request = {
      state: { prompt_text: fixture.input.promptText.slice(0, MAX_PROMPT_CHARS), truncated_input: false },
      questions: QUESTIONS,
      model: REQUESTED_MODEL,
    }
    state.builtRequestCount += Object.keys(request.questions).length === QUESTION_IDS.length ? 1 : 0
    state.completedFixtureIds.push(fixture.id)
  }
  return createArtifact(
    { mode: "dry-run", callCounter: calls, networkCounter: networkCalls },
    state,
    { status: "complete", failure: null },
  )
}
async function runAccuracyHarness(options: HarnessOptions): Promise<AccuracyArtifact> {
  const state: HarnessState = {
    resolvedModel: null,
    builtRequestCount: 0,
    fixtureExactMatches: 0,
    correctAnswers: 0,
    scoredAnswers: 0,
    completedFixtureIds: [],
    fixtureResults: [],
    unavailableFixtures: [],
    confusionMatrices: emptyMatrices(),
  }
  for (const fixture of options.fixtures) {
    validateFixture(fixture)
    if (options.callCounter.calls >= options.maxCalls) {
      const error = new IntentRoutingCallCeilingError(options.maxCalls)
      options.emit(createArtifact(options, state, {
        status: "partial",
        failure: { name: error.name, fixtureId: fixture.id },
      }))
      throw error
    }
    options.callCounter.calls += 1
    state.builtRequestCount += 1
    const result = await decideIntentRouting({
      backend: options.backendForFixture(fixture),
      input: fixture.input,
      vocab: HARNESS_VOCABULARY,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      model: REQUESTED_MODEL,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    if (result.predictionStatus !== "filled" || result.answers === null) {
      const error = new IntentRoutingAccuracyRunError(fixture.id, result.unavailableReason ?? "missing answers")
      options.emit(createArtifact(options, state, {
        status: "partial",
        failure: { name: error.name, fixtureId: fixture.id },
      }))
      throw error
    }
    state.resolvedModel = result.resolvedModel
    recordScore(state, fixture, result.answers)
  }
  const artifact = createArtifact(options, state, { status: "complete", failure: null })
  options.emit(artifact)
  return artifact
}
async function runMissingKeyHarness(options: HarnessOptions): Promise<AccuracyArtifact> {
  const state: HarnessState = {
    resolvedModel: null,
    builtRequestCount: 0,
    fixtureExactMatches: 0,
    correctAnswers: 0,
    scoredAnswers: 0,
    completedFixtureIds: [],
    fixtureResults: [],
    unavailableFixtures: [],
    confusionMatrices: emptyMatrices(),
  }
  for (const fixture of options.fixtures) {
    if (options.callCounter.calls >= options.maxCalls) throw new IntentRoutingCallCeilingError(options.maxCalls)
    options.callCounter.calls += 1
    state.builtRequestCount += 1
    const result = await decideIntentRouting({
      backend: options.backendForFixture(fixture),
      input: fixture.input,
      vocab: HARNESS_VOCABULARY,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      model: REQUESTED_MODEL,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    if (result.unavailableReason !== "missing_api_key") {
      throw new IntentRoutingAccuracyRunError(fixture.id, result.unavailableReason ?? "expected missing_api_key")
    }
    state.completedFixtureIds.push(fixture.id)
    state.unavailableFixtures.push({ fixtureId: fixture.id, reason: result.unavailableReason })
  }
  const artifact = createArtifact(options, state, { status: "complete", failure: null })
  options.emit(artifact)
  return artifact
}

if (DIRECT_DRY_RUN) {
  const artifact = runDryRun({ calls: 0 }, { calls: 0 })
  if (artifact.callCount !== 0 || artifact.networkCallCount !== 0) {
    throw new TypeError("Intent-routing dry-run dispatched a call")
  }
  console.log(`JEV_W1_ACCURACY_ARTIFACT ${JSON.stringify(artifact)}`)
} else {
describe("intent-routing accuracy harness", () => {
  test("#given fixture intent labels #when the harness vocabulary is built #then every label is a producible option", () => {
    const options = new Set(Object.keys(QUESTIONS.intent.criteria))
    expect(INTENT_ROUTING_FIXTURES.every((fixture) => options.has(fixture.label.intent))).toBe(true)
  })

  test("#given dry-run mode #when every fixture request is built #then no backend or network call occurs", () => {
    const artifact = runDryRun({ calls: 0 }, { calls: 0 })
    expect(artifact).toMatchObject({
      status: "complete",
      mode: "dry-run",
      callCount: 0,
      networkCallCount: 0,
      builtRequestCount: INTENT_ROUTING_FIXTURES.length,
      scoredAnswers: 0,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    })
  })

  test("#given the real API flag #when mode is selected #then missing credentials stay on the real short-circuit path", () => {
    expect(selectRunMode({ JEV_W1_REAL_API: "1", TYPESAFE_API_KEY: "secret" }, false)).toBe("real")
    expect(selectRunMode({ JEV_W1_REAL_API: "1" }, false)).toBe("real")
    expect(selectRunMode({ TYPESAFE_API_KEY: "secret" }, false)).toBe("mock")
    expect(selectRunMode({ JEV_W1_REAL_API: "1", TYPESAFE_API_KEY: "secret" }, true)).toBe("dry-run")
  })

  test("#given a counter one below its ceiling #when two fixtures are dispatched #then IntentRoutingCallCeilingError aborts before the second backend call", async () => {
    const calls = { calls: 1 }
    let backendCalls = 0
    let partial: AccuracyArtifact | undefined
    const invoke = runAccuracyHarness({
      mode: "mock",
      fixtures: INTENT_ROUTING_FIXTURES.slice(0, 2),
      backendForFixture: (fixture) => {
        backendCalls += 1
        return createMockBackend(fixture)
      },
      callCounter: calls,
      networkCounter: { calls: 0 },
      maxCalls: 2,
      emit: (artifact) => { partial = artifact },
    })
    await expect(invoke).rejects.toBeInstanceOf(IntentRoutingCallCeilingError)
    expect({ backendCalls, calls: calls.calls, status: partial?.status, failure: partial?.failure?.name }).toEqual({
      backendCalls: 1,
      calls: 2,
      status: "partial",
      failure: "IntentRoutingCallCeilingError",
    })
  })

  test("#given a backend failure at fixture eight #when the run aborts #then its partial artifact retains the first seven fixture ids", async () => {
    const eighthId = INTENT_ROUTING_FIXTURES[7]?.id
    if (eighthId === undefined) throw new TypeError("Expected at least eight intent-routing fixtures")
    let partial: AccuracyArtifact | undefined
    const calls = { calls: 0 }
    const invoke = runAccuracyHarness({
      mode: "mock",
      fixtures: INTENT_ROUTING_FIXTURES,
      backendForFixture: (fixture) => fixture.id === eighthId ? createMockDecisionBackend({}) : createMockBackend(fixture),
      callCounter: calls,
      networkCounter: { calls: 0 },
      maxCalls: INTENT_ROUTING_FIXTURES.length,
      emit: (artifact) => { partial = artifact },
    })
    await expect(invoke).rejects.toBeInstanceOf(IntentRoutingAccuracyRunError)
    expect(partial).toMatchObject({
      status: "partial",
      failure: { name: "IntentRoutingAccuracyRunError", fixtureId: eighthId },
      completedFixtureIds: INTENT_ROUTING_FIXTURES.slice(0, 7).map((fixture) => fixture.id),
      callCount: 8,
    })
  })

  test("#given configured mode #when every fixture is scored #then a versioned per-question artifact is emitted without an accuracy gate", async () => {
    const mode = selectRunMode(process.env, false)
    const calls = { calls: 0 }
    const networkCalls = { calls: 0 }
    const emit = (result: AccuracyArtifact): void => {
      console.log(`JEV_W1_ACCURACY_ARTIFACT ${JSON.stringify(result)}`)
    }
    let artifact: AccuracyArtifact
    if (mode === "dry-run") {
      artifact = runDryRun(calls, networkCalls)
      emit(artifact)
    } else if (mode === "real") {
      const apiKey = process.env.TYPESAFE_API_KEY
      const countedFetch: Fetch = async (url, init) => {
        networkCalls.calls += 1
        return globalThis.fetch(url, init)
      }
      const metrics = emptyMetrics()
      const backend = createMeasuredBackend(
        createRealDecisionBackend({ apiKey, model: REQUESTED_MODEL, timeoutMs: 10_000, fetch: countedFetch }),
        metrics,
      )
      const options: HarnessOptions = {
        mode,
        fixtures: INTENT_ROUTING_FIXTURES,
        backendForFixture: () => backend,
        callCounter: calls,
        networkCounter: networkCalls,
        maxCalls: INTENT_ROUTING_FIXTURES.length,
        emit,
        metrics,
      }
      artifact = apiKey ? await runAccuracyHarness(options) : await runMissingKeyHarness(options)
    } else {
      artifact = await runAccuracyHarness({
        mode,
        fixtures: INTENT_ROUTING_FIXTURES,
        backendForFixture: createMockBackend,
        callCounter: calls,
        networkCounter: networkCalls,
        maxCalls: INTENT_ROUTING_FIXTURES.length,
        emit,
      })
    }
    expect(artifact.status).toBe("complete")
    expect(Object.keys(artifact.confusionMatrices)).toEqual([...QUESTION_IDS])
    expect(artifact.completedFixtureIds).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    if (mode === "real" && !process.env.TYPESAFE_API_KEY) {
      expect(artifact.unavailableFixtures).toHaveLength(INTENT_ROUTING_FIXTURES.length)
      expect(artifact.unavailableFixtures.every((entry) => entry.reason === "missing_api_key")).toBe(true)
      expect(artifact.networkCallCount).toBe(0)
    }
    if (mode !== "real") expect(artifact.networkCallCount).toBe(0)
    if (mode === "mock") expect(artifact.resolvedModel).toBe(MOCK_RESOLVED_MODEL)
  })
})
}
