// allow: SIZE_OK - the work plan requires the executable harness and all probes in one test file.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  INTENT_ROUTING_FIXTURES,
  INTENT_ROUTING_QUESTION_VERSION,
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
  buildIntentRoutingQuestions,
  choiceAnswer,
  createMockDecisionBackend,
  decideIntentRouting,
  selectDecisionBackend,
  type DecisionBackend,
  type DecisionOutcome,
  type DecisionRequest,
  type IntentRoutingDecisionResult,
  type IntentRoutingFixture,
  type IntentRoutingQuestions,
  type IntentRoutingVocabulary,
  type Questions,
  type RealDecisionBackendDeps,
} from "./index"

const CALL_CEILING = 15
const CONFIDENCE_THRESHOLD = 0.8
const MAX_PROMPT_CHARS = 2_000
const REAL_API_TIMEOUT_MS = 5_000
const REQUESTED_MODEL = process.env.JEV_W1_MODEL?.trim() || "jev-latest"
const ARTIFACT_PATH = join(
  process.cwd(),
  ".omo/evidence/20260924-jev-w1/task-8-accuracy-result.json",
)

const VOCAB = {
  categories: [
    "visual-engineering", "ultrabrain", "deep", "artistry", "quick",
    "unspecified-low", "unspecified-high", "writing",
  ].map((name) => ({ name, description: name })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY.filter((name) => name !== "none")
    .map((name) => ({ name, description: name })),
  intents: ["research", "implementation", "investigation", "evaluation", "fix", "open-ended"]
    .map((name) => ({ name, description: name })),
} satisfies IntentRoutingVocabulary

const QUESTIONS = buildIntentRoutingQuestions(VOCAB)
const QUESTION_NAMES = ["intent", "category", "subagent", "ambiguous"] as const
type QuestionName = (typeof QUESTION_NAMES)[number]
type BackendFetch = NonNullable<RealDecisionBackendDeps["fetch"]>
type BackendMode = "mock" | "real"
type RunMode = BackendMode | "dry-run"
type MutableCounter = { value: number }
type ConfusionMatrix = Readonly<Record<string, Readonly<Record<string, number>>>>
type MutableMatrices = Record<QuestionName, Record<string, Record<string, number>>>
type AccuracyArtifact = {
  readonly status: "complete" | "partial"
  readonly backend: BackendMode | "none"
  readonly mode: RunMode
  readonly paidApi: boolean
  readonly fixtureCount: number
  readonly builtRequestCount: number
  readonly completedFixtureIds: readonly string[]
  readonly failedFixtureId: string | null
  readonly failureReason: string | null
  readonly callCeiling: number
  readonly callCount: number
  readonly networkCallCount: number
  readonly requestedModel: string
  readonly resolvedModel: string | null
  readonly questionVersion: number
  readonly accuracy: Readonly<Record<QuestionName, number | null>>
  readonly confusionMatrices: Readonly<Record<QuestionName, ConfusionMatrix>>
}
type AccuracyRunOptions = {
  readonly fixtures: readonly IntentRoutingFixture[]
  readonly mode: BackendMode
  readonly artifactPath: string
  readonly callBudget: CallBudget
  readonly networkCounter: MutableCounter
  readonly backendForFixture: (fixture: IntentRoutingFixture) => DecisionBackend
}

class IntentRoutingCallCeilingError extends Error {
  constructor(public readonly ceiling: number, public readonly fixtureId: string) {
    super(`Intent-routing call ceiling ${ceiling} reached before fixture ${fixtureId}`)
    this.name = "IntentRoutingCallCeilingError"
  }
}

class IntentRoutingFixtureSetError extends Error {
  constructor(public readonly issue: string) {
    super(`Invalid intent-routing fixture set: ${issue}`)
    this.name = "IntentRoutingFixtureSetError"
  }
}

class IntentRoutingRealApiGateError extends Error {
  constructor() {
    super("JEV_W1_REAL_API=1 requires TYPESAFE_API_KEY")
    this.name = "IntentRoutingRealApiGateError"
  }
}

class UnexpectedNetworkCallError extends Error {
  constructor() {
    super("The no-network path attempted a fetch")
    this.name = "UnexpectedNetworkCallError"
  }
}

class CallBudget {
  constructor(public readonly ceiling: number, private used = 0) {}

  reserve(fixtureId: string): void {
    if (this.used >= this.ceiling) throw new IntentRoutingCallCeilingError(this.ceiling, fixtureId)
    this.used += 1
  }

  get count(): number {
    return this.used
  }
}

function createCountingFetch(counter: MutableCounter, networkEnabled: boolean): BackendFetch {
  return async (input, init) => {
    counter.value += 1
    if (!networkEnabled) throw new UnexpectedNetworkCallError()
    return fetch(input, init)
  }
}

function assertFixtureSet(fixtures: readonly IntentRoutingFixture[]): void {
  if (fixtures.length === 0) throw new IntentRoutingFixtureSetError("must contain a fixture")
  const ids = new Set<string>()
  for (const fixture of fixtures) {
    if (fixture.id.trim() === "" || ids.has(fixture.id)) {
      throw new IntentRoutingFixtureSetError(`invalid or duplicate id ${fixture.id}`)
    }
    if (fixture.input.promptText.trim() === "") {
      throw new IntentRoutingFixtureSetError(`${fixture.id} has an empty prompt`)
    }
    if (!(fixture.label.intent in QUESTIONS.intent.criteria)) {
      throw new IntentRoutingFixtureSetError(`${fixture.id} has an unknown intent`)
    }
    if (!(fixture.label.category in QUESTIONS.category.criteria)) {
      throw new IntentRoutingFixtureSetError(`${fixture.id} has an unknown category`)
    }
    if (!(fixture.label.subagent in QUESTIONS.subagent.criteria)) {
      throw new IntentRoutingFixtureSetError(`${fixture.id} has an unknown subagent`)
    }
    if (!Number.isFinite(fixture.label.ambiguous) || fixture.label.ambiguous < 0 || fixture.label.ambiguous > 1) {
      throw new IntentRoutingFixtureSetError(`${fixture.id} has invalid ambiguity`)
    }
    ids.add(fixture.id)
  }
}

function createMatrices(): MutableMatrices {
  return { intent: {}, category: {}, subagent: {}, ambiguous: {} }
}

function recordPrediction(
  matrices: MutableMatrices,
  correct: Record<QuestionName, number>,
  question: QuestionName,
  actual: string,
  predicted: string,
): void {
  const row = matrices[question][actual] ?? {}
  row[predicted] = (row[predicted] ?? 0) + 1
  matrices[question][actual] = row
  if (actual === predicted) correct[question] += 1
}

function predictionFrom(result: IntentRoutingDecisionResult): Readonly<Record<QuestionName, string>> | null {
  const { intent, category, subagent, ambiguous } = result.answers
  if (
    result.predictionStatus !== "filled" || result.invalidAnswerCount !== 0 ||
    !intent.valid || intent.choice === null || !category.valid || category.choice === null ||
    !subagent.valid || subagent.choice === null || !ambiguous.valid || ambiguous.noul === null
  ) return null
  return {
    intent: intent.choice,
    category: category.choice,
    subagent: subagent.choice,
    ambiguous: ambiguous.noul >= 0.5 ? "ambiguous" : "unambiguous",
  }
}

function createArtifact(args: {
  readonly status: "complete" | "partial"
  readonly mode: RunMode
  readonly fixtures: readonly IntentRoutingFixture[]
  readonly builtRequestCount: number
  readonly completedFixtureIds: readonly string[]
  readonly failedFixtureId: string | null
  readonly failureReason: string | null
  readonly callCount: number
  readonly networkCallCount: number
  readonly resolvedModel: string | null
  readonly correct: Readonly<Record<QuestionName, number>>
  readonly matrices: MutableMatrices
}): AccuracyArtifact {
  const denominator = args.completedFixtureIds.length
  return {
    status: args.status,
    backend: args.mode === "dry-run" ? "none" : args.mode,
    mode: args.mode,
    paidApi: args.mode === "real",
    fixtureCount: args.fixtures.length,
    builtRequestCount: args.builtRequestCount,
    completedFixtureIds: [...args.completedFixtureIds],
    failedFixtureId: args.failedFixtureId,
    failureReason: args.failureReason,
    callCeiling: CALL_CEILING,
    callCount: args.callCount,
    networkCallCount: args.networkCallCount,
    requestedModel: REQUESTED_MODEL,
    resolvedModel: args.resolvedModel,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
    accuracy: {
      intent: denominator === 0 ? null : args.correct.intent / denominator,
      category: denominator === 0 ? null : args.correct.category / denominator,
      subagent: denominator === 0 ? null : args.correct.subagent / denominator,
      ambiguous: denominator === 0 ? null : args.correct.ambiguous / denominator,
    },
    confusionMatrices: args.matrices,
  }
}

async function emitArtifact(path: string, artifact: AccuracyArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const pendingPath = `${path}.${process.pid}.tmp`
  await writeFile(pendingPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  await rename(pendingPath, path)
}

function mockBackendFor(fixture: IntentRoutingFixture, countingFetch: BackendFetch): DecisionBackend {
  return selectDecisionBackend(
    { enabled: true, backend: "mock", model: REQUESTED_MODEL, timeoutMs: REAL_API_TIMEOUT_MS },
    {
      fetch: countingFetch,
      mockScript: {
        intent: choiceAnswer(fixture.label.intent, 0.99, Object.keys(QUESTIONS.intent.criteria)),
        category: choiceAnswer(fixture.label.category, 0.99, Object.keys(QUESTIONS.category.criteria)),
        subagent: choiceAnswer(fixture.label.subagent, 0.99, Object.keys(QUESTIONS.subagent.criteria)),
        ambiguous: { type: "noul", noul: fixture.label.ambiguous },
      },
    },
  )
}

async function runDryRun(fixtures: readonly IntentRoutingFixture[], artifactPath: string): Promise<AccuracyArtifact> {
  assertFixtureSet(fixtures)
  let builtRequestCount = 0
  for (const fixture of fixtures) {
    const request = {
      state: { promptText: fixture.input.promptText, truncatedInput: false },
      questions: buildIntentRoutingQuestions(VOCAB),
      model: REQUESTED_MODEL,
    } satisfies DecisionRequest<IntentRoutingQuestions>
    if (Object.keys(request.questions).length !== QUESTION_NAMES.length) {
      throw new IntentRoutingFixtureSetError(`${fixture.id} did not build every question`)
    }
    builtRequestCount += 1
  }
  const artifact = createArtifact({
    status: "complete", mode: "dry-run", fixtures, builtRequestCount,
    completedFixtureIds: fixtures.map((fixture) => fixture.id), failedFixtureId: null,
    failureReason: null, callCount: 0, networkCallCount: 0, resolvedModel: null,
    correct: { intent: 0, category: 0, subagent: 0, ambiguous: 0 }, matrices: createMatrices(),
  })
  await emitArtifact(artifactPath, artifact)
  return artifact
}

async function runAccuracy(options: AccuracyRunOptions): Promise<AccuracyArtifact> {
  assertFixtureSet(options.fixtures)
  const completedFixtureIds: string[] = []
  const matrices = createMatrices()
  const correct = { intent: 0, category: 0, subagent: 0, ambiguous: 0 }
  let resolvedModel: string | null = null
  let artifact = createArtifact({
    status: "partial", mode: options.mode, fixtures: options.fixtures, builtRequestCount: 0,
    completedFixtureIds, failedFixtureId: null, failureReason: null,
    callCount: options.callBudget.count, networkCallCount: options.networkCounter.value,
    resolvedModel, correct, matrices,
  })
  await emitArtifact(options.artifactPath, artifact)

  for (const fixture of options.fixtures) {
    options.callBudget.reserve(fixture.id)
    const result = await decideIntentRouting({
      backend: options.backendForFixture(fixture), input: fixture.input, vocab: VOCAB,
      confidenceThreshold: CONFIDENCE_THRESHOLD, model: REQUESTED_MODEL,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    const prediction = predictionFrom(result)
    const failureReason = result.unavailableReason ?? (prediction === null ? "invalid_answer" : null)
    if (prediction === null || failureReason !== null) {
      artifact = createArtifact({
        status: "partial", mode: options.mode, fixtures: options.fixtures,
        builtRequestCount: options.callBudget.count, completedFixtureIds,
        failedFixtureId: fixture.id, failureReason,
        callCount: options.callBudget.count, networkCallCount: options.networkCounter.value,
        resolvedModel, correct, matrices,
      })
      await emitArtifact(options.artifactPath, artifact)
      return artifact
    }
    if (resolvedModel !== null && resolvedModel !== result.resolvedModel) {
      artifact = createArtifact({
        status: "partial", mode: options.mode, fixtures: options.fixtures,
        builtRequestCount: options.callBudget.count, completedFixtureIds,
        failedFixtureId: fixture.id, failureReason: "resolved_model_changed",
        callCount: options.callBudget.count, networkCallCount: options.networkCounter.value,
        resolvedModel, correct, matrices,
      })
      await emitArtifact(options.artifactPath, artifact)
      return artifact
    }
    resolvedModel = result.resolvedModel
    recordPrediction(matrices, correct, "intent", fixture.label.intent, prediction.intent)
    recordPrediction(matrices, correct, "category", fixture.label.category, prediction.category)
    recordPrediction(matrices, correct, "subagent", fixture.label.subagent, prediction.subagent)
    recordPrediction(
      matrices, correct, "ambiguous",
      fixture.label.ambiguous >= 0.5 ? "ambiguous" : "unambiguous",
      prediction.ambiguous,
    )
    completedFixtureIds.push(fixture.id)
    artifact = createArtifact({
      status: "partial", mode: options.mode, fixtures: options.fixtures,
      builtRequestCount: options.callBudget.count, completedFixtureIds,
      failedFixtureId: null, failureReason: null,
      callCount: options.callBudget.count, networkCallCount: options.networkCounter.value,
      resolvedModel, correct, matrices,
    })
    await emitArtifact(options.artifactPath, artifact)
  }

  artifact = { ...artifact, status: "complete" }
  await emitArtifact(options.artifactPath, artifact)
  return artifact
}

async function withTempArtifact(
  action: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "jev-w1-accuracy-"))
  try {
    await action(join(directory, "artifact.json"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function matrixTotal(matrix: ConfusionMatrix): number {
  return Object.values(matrix).reduce(
    (total, row) => total + Object.values(row).reduce((rowTotal, count) => rowTotal + count, 0),
    0,
  )
}

if (Bun.argv.includes("--dry-run")) {
  const networkCounter = { value: 0 }
  createCountingFetch(networkCounter, false)
  const artifact = await runDryRun(INTENT_ROUTING_FIXTURES, ARTIFACT_PATH)
  if (artifact.callCount !== 0 || artifact.networkCallCount !== 0 || networkCounter.value !== 0) {
    throw new UnexpectedNetworkCallError()
  }
  console.log(`dry-run fixtures=${artifact.builtRequestCount} callCount=0 networkCalls=0`)
} else describe("intent-routing accuracy harness", () => {
  test("#given the selected execution mode #when evaluating fixtures #then the artifact is explicit and bounded", async () => {
    const dryRun = Bun.argv.includes("--dry-run")
    const realRequested = process.env.JEV_W1_REAL_API === "1"
    const apiKey = process.env.TYPESAFE_API_KEY?.trim()
    if (!dryRun && realRequested && !apiKey) throw new IntentRoutingRealApiGateError()

    if (dryRun) {
      const artifact = await runDryRun(INTENT_ROUTING_FIXTURES, ARTIFACT_PATH)
      expect(artifact.builtRequestCount).toBe(INTENT_ROUTING_FIXTURES.length)
      expect(artifact.callCount).toBe(0)
      expect(artifact.networkCallCount).toBe(0)
      console.log(`dry-run fixtures=${artifact.builtRequestCount} networkCalls=0`)
      return
    }

    const mode: BackendMode = realRequested ? "real" : "mock"
    const networkCounter = { value: 0 }
    const countingFetch = createCountingFetch(networkCounter, mode === "real")
    const realBackend = mode === "real"
      ? selectDecisionBackend(
          { enabled: true, backend: "real", model: REQUESTED_MODEL, timeoutMs: REAL_API_TIMEOUT_MS },
          { apiKey, fetch: countingFetch },
        )
      : null
    const artifact = await runAccuracy({
      fixtures: INTENT_ROUTING_FIXTURES, mode, artifactPath: ARTIFACT_PATH,
      callBudget: new CallBudget(CALL_CEILING), networkCounter,
      backendForFixture: (fixture) => realBackend ?? mockBackendFor(fixture, countingFetch),
    })

    expect(artifact.status).toBe("complete")
    expect(artifact.completedFixtureIds).toEqual(INTENT_ROUTING_FIXTURES.map((fixture) => fixture.id))
    expect(artifact.callCount).toBe(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.resolvedModel).not.toBeNull()
    expect(artifact.questionVersion).toBe(INTENT_ROUTING_QUESTION_VERSION)
    for (const name of QUESTION_NAMES) {
      expect(matrixTotal(artifact.confusionMatrices[name]), name).toBe(INTENT_ROUTING_FIXTURES.length)
    }
    if (mode === "mock") {
      expect(artifact.networkCallCount).toBe(0)
      expect(artifact).toMatchObject({ backend: "mock", paidApi: false })
    } else {
      expect(artifact.networkCallCount).toBeGreaterThan(0)
      expect(artifact).toMatchObject({ backend: "real", paidApi: true })
    }
    console.log(
      `accuracy backend=${artifact.backend} paidApi=${artifact.paidApi} fixtures=${artifact.completedFixtureIds.length} networkCalls=${artifact.networkCallCount} resolvedModel=${artifact.resolvedModel} questionVersion=${artifact.questionVersion}`,
    )
  })

  test("#given dry-run mode #when every request is built #then the fetch and call counts remain exactly zero", async () => {
    await withTempArtifact(async (path) => {
      const networkCounter = { value: 0 }
      createCountingFetch(networkCounter, false)
      const artifact = await runDryRun(INTENT_ROUTING_FIXTURES, path)

      expect(artifact.builtRequestCount).toBe(INTENT_ROUTING_FIXTURES.length)
      expect(artifact.callCount).toBe(0)
      expect(artifact.networkCallCount).toBe(0)
      expect(networkCounter.value).toBe(0)
      console.log(`dry-run verified fixtures=${artifact.builtRequestCount} callCount=0 networkCalls=0`)
    })
  })

  test("#given a counter one below its ceiling #when two fixtures dispatch #then a named error aborts before the second backend call", async () => {
    await withTempArtifact(async (path) => {
      const networkCounter = { value: 0 }
      const countingFetch = createCountingFetch(networkCounter, false)
      let backendCalls = 0
      let thrown: unknown
      try {
        await runAccuracy({
          fixtures: INTENT_ROUTING_FIXTURES.slice(0, 2), mode: "mock", artifactPath: path,
          callBudget: new CallBudget(CALL_CEILING, CALL_CEILING - 1), networkCounter,
          backendForFixture: (fixture) => {
            backendCalls += 1
            return mockBackendFor(fixture, countingFetch)
          },
        })
      } catch (error) {
        if (!(error instanceof IntentRoutingCallCeilingError)) throw error
        thrown = error
      }

      expect(thrown).toBeInstanceOf(IntentRoutingCallCeilingError)
      expect(backendCalls).toBe(1)
      expect(networkCounter.value).toBe(0)
      const retained = await readFile(path, "utf8")
      expect(retained).toContain('"status": "partial"')
      expect(retained).toContain(INTENT_ROUTING_FIXTURES[0]?.id)
      console.log(`ceiling-abort name=IntentRoutingCallCeilingError ceiling=${CALL_CEILING} backendCalls=${backendCalls}`)
    })
  })

  test("#given a failed paid-style fixture #when the run stops #then partial progress is retained and a later run overwrites it", async () => {
    await withTempArtifact(async (path) => {
      await writeFile(path, "stale-data-that-must-not-survive", "utf8")
      const fixtures = INTENT_ROUTING_FIXTURES.slice(0, 3)
      const networkCounter = { value: 0 }
      const countingFetch = createCountingFetch(networkCounter, false)
      let backendCalls = 0
      const partial = await runAccuracy({
        fixtures, mode: "mock", artifactPath: path, callBudget: new CallBudget(CALL_CEILING),
        networkCounter,
        backendForFixture: (fixture) => {
          backendCalls += 1
          return backendCalls === 2 ? createMockDecisionBackend({}) : mockBackendFor(fixture, countingFetch)
        },
      })

      expect(partial).toMatchObject({ status: "partial", failedFixtureId: fixtures[1]?.id })
      expect(partial.completedFixtureIds).toEqual([fixtures[0]?.id])
      expect(backendCalls).toBe(2)
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(partial, null, 2)}\n`)

      const complete = await runAccuracy({
        fixtures: fixtures.slice(0, 1), mode: "mock", artifactPath: path,
        callBudget: new CallBudget(CALL_CEILING), networkCounter,
        backendForFixture: (fixture) => mockBackendFor(fixture, countingFetch),
      })
      expect(complete.status).toBe("complete")
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(complete, null, 2)}\n`)
    })
  })

  test("#given a backend answer keyed by a nonexistent fixture #when scoring #then the run is partial instead of reporting accuracy", async () => {
    await withTempArtifact(async (path) => {
      const fixture = INTENT_ROUTING_FIXTURES[0]
      if (fixture === undefined) throw new IntentRoutingFixtureSetError("probe fixture missing")
      const delegate = mockBackendFor(fixture, createCountingFetch({ value: 0 }, false))
      const backend: DecisionBackend = {
        kind: "mock",
        async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
          const outcome = await delegate.decide(request)
          if (outcome.status === "unavailable") return outcome
          return {
            ...outcome,
            answers: {
              ...outcome.answers,
              "fixture-that-does-not-exist": choiceAnswer("none", 1, ["none"]),
            },
          }
        },
      }
      const artifact = await runAccuracy({
        fixtures: [fixture], mode: "mock", artifactPath: path,
        callBudget: new CallBudget(CALL_CEILING), networkCounter: { value: 0 },
        backendForFixture: () => backend,
      })

      expect(artifact).toMatchObject({
        status: "partial", failedFixtureId: fixture.id, failureReason: "invalid_answer",
      })
      expect(artifact.completedFixtureIds).toEqual([])
    })
  })

  test("#given an unparseable answer and an empty fixture set #when running #then neither can produce a complete artifact", async () => {
    await withTempArtifact(async (path) => {
      const fixture = INTENT_ROUTING_FIXTURES[0]
      if (fixture === undefined) throw new IntentRoutingFixtureSetError("probe fixture missing")
      const malformed = createMockDecisionBackend({
        intent: choiceAnswer(fixture.label.intent, Number.NaN, Object.keys(QUESTIONS.intent.criteria)),
        category: choiceAnswer(fixture.label.category, 0.99, Object.keys(QUESTIONS.category.criteria)),
        subagent: choiceAnswer(fixture.label.subagent, 0.99, Object.keys(QUESTIONS.subagent.criteria)),
        ambiguous: { type: "noul", noul: fixture.label.ambiguous },
      })
      const partial = await runAccuracy({
        fixtures: [fixture], mode: "mock", artifactPath: path,
        callBudget: new CallBudget(CALL_CEILING), networkCounter: { value: 0 },
        backendForFixture: () => malformed,
      })

      expect(partial).toMatchObject({ status: "partial", failureReason: "unscripted" })
      await expect(runDryRun([], path)).rejects.toBeInstanceOf(IntentRoutingFixtureSetError)
    })
  })
})
