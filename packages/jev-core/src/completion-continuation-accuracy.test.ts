import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { COMPLETION_CONTINUATION_FIXTURES, type CompletionContinuationFixture } from "./completion-continuation-fixtures"
import { COMPLETION_CONTINUATION_QUESTION_KEYS, COMPLETION_CONTINUATION_QUESTION_VERSION, type CompletionContinuationQuestionKey } from "./completion-continuation-questions"
import { COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES, COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES, COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES, buildCompletionContinuationState } from "./completion-continuation-state"
import { decideCompletionContinuation, type CompletionContinuationDecisionResult } from "./completion-continuation"
import { createMockDecisionBackend } from "./mock-backend"
import { selectDecisionBackend } from "./backend-selector"
import type { DecisionBackend, RealDecisionBackendDeps } from "./index"
const PAID_CALL_CEILING = 18
const CONFIDENCE_THRESHOLD = 0.8
const TIMEOUT_MS = 2_500
const REQUESTED_MODEL = "jev-latest"
const ARTIFACT_PATH = join(process.cwd(), ".omo/evidence/20260930-jev-w2/task-7-accuracy-result.json")
const BYTE_CAPS = {
  state: COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  todoContent: COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  transcript: COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  diffPaths: COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
} as const
type MutableCounter = { value: number }
type BackendFetch = NonNullable<RealDecisionBackendDeps["fetch"]>
type Matrix = Record<string, Record<string, number>>
type Matrices = Record<CompletionContinuationQuestionKey, Matrix>
type HarnessArtifact = {
  readonly status: "complete" | "partial"
  readonly mode: "mock" | "dry-run"
  readonly fixtureCount: number
  readonly builtStateCount: number
  readonly completedFixtureIds: readonly string[]
  readonly failedFixtureId: string | null
  readonly failureReason: string | null
  readonly callCeiling: number
  readonly callCount: number
  readonly networkCallCount: number
  readonly requestedModel: string
  readonly resolvedModel: string | null
  readonly questionVersion: number
  readonly byteCaps: typeof BYTE_CAPS
  readonly confusionMatrices: Matrices
}
type RunOptions = {
  readonly fixtures: readonly CompletionContinuationFixture[]
  readonly artifactPath: string
  readonly budget: RequestBudget
  readonly networkCounter: MutableCounter
  readonly backendFor: (fixture: CompletionContinuationFixture) => DecisionBackend
}
class PaidCallCeilingError extends Error {
  readonly name = "PaidCallCeilingError"
  constructor(readonly ceiling: number, readonly nextOrdinal: number) {
    super(`Paid call ceiling ${ceiling} reached before call ${nextOrdinal}`)
  }
}
class UnexpectedNetworkCallError extends Error {
  readonly name = "UnexpectedNetworkCallError"
  constructor() { super("Mock completion-continuation harness attempted fetch") }
}
/** Mutable request budget whose purpose is to reserve paid calls before dispatch. */
class RequestBudget {
  constructor(readonly ceiling: number, private used = 0) {}
  reserve(): void {
    if (this.used >= this.ceiling) throw new PaidCallCeilingError(this.ceiling, this.used + 1)
    this.used += 1
  }
  get count(): number { return this.used }
}
function createCountingFetch(counter: MutableCounter): BackendFetch {
  return async () => {
    counter.value += 1
    throw new UnexpectedNetworkCallError()
  }
}
function createMatrices(): Matrices { return { actually_complete: {}, progressing: {}, stuck: {} } }

function mockBackend(fixture: CompletionContinuationFixture, countingFetch: BackendFetch): DecisionBackend {
  const probability = (truth: boolean | "unknown") => truth === true ? 0.95 : truth === false ? 0.05 : 0.5
  return selectDecisionBackend(
    { enabled: true, backend: "mock", model: REQUESTED_MODEL, timeoutMs: TIMEOUT_MS },
    { fetch: countingFetch, mockScript: {
      actually_complete: { type: "noul", noul: probability(fixture.label.actuallyComplete) },
      progressing: { type: "noul", noul: probability(fixture.label.progressing) },
      stuck: { type: "noul", noul: probability(fixture.label.stuck) },
    } },
  )
}
function recordPredictions(matrices: Matrices, fixture: CompletionContinuationFixture, result: CompletionContinuationDecisionResult): void {
  const actual = {
    actually_complete: String(fixture.label.actuallyComplete),
    progressing: String(fixture.label.progressing),
    stuck: String(fixture.label.stuck),
  } satisfies Record<CompletionContinuationQuestionKey, string>
  const predicted = {
    actually_complete: result.thresholdLabels.actuallyComplete,
    progressing: result.thresholdLabels.progressing,
    stuck: result.thresholdLabels.stuck,
  } satisfies Record<CompletionContinuationQuestionKey, string>
  for (const question of COMPLETION_CONTINUATION_QUESTION_KEYS) {
    const row = matrices[question][actual[question]] ?? {}
    row[predicted[question]] = (row[predicted[question]] ?? 0) + 1
    matrices[question][actual[question]] = row
  }
}
async function emitArtifact(path: string, artifact: HarnessArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const pending = `${path}.${process.pid}.tmp`
  await writeFile(pending, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  await rename(pending, path)
}
function artifact(args: Omit<HarnessArtifact, "fixtureCount" | "callCeiling" | "questionVersion" | "byteCaps"> & { readonly fixtureCount: number }): HarnessArtifact {
  return { ...args, callCeiling: PAID_CALL_CEILING, questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION, byteCaps: BYTE_CAPS }
}
async function runDryRun(fixtures: readonly CompletionContinuationFixture[], path: string): Promise<HarnessArtifact> {
  const states = fixtures.map((fixture) => buildCompletionContinuationState(fixture.input))
  const result = artifact({
    status: "complete", mode: "dry-run", fixtureCount: fixtures.length, builtStateCount: states.length,
    completedFixtureIds: fixtures.map(({ id }) => id), failedFixtureId: null, failureReason: null,
    callCount: 0, networkCallCount: 0, requestedModel: REQUESTED_MODEL, resolvedModel: null,
    confusionMatrices: createMatrices(),
  })
  await emitArtifact(path, result)
  return result
}
async function runAccuracy(options: RunOptions): Promise<HarnessArtifact> {
  const completedFixtureIds: string[] = []
  const matrices = createMatrices()
  let resolvedModel: string | null = null
  let current = artifact({
    status: "partial", mode: "mock", fixtureCount: options.fixtures.length, builtStateCount: 0,
    completedFixtureIds, failedFixtureId: null, failureReason: null, callCount: options.budget.count,
    networkCallCount: options.networkCounter.value, requestedModel: REQUESTED_MODEL, resolvedModel,
    confusionMatrices: matrices,
  })
  await emitArtifact(options.artifactPath, current)
  for (const fixture of options.fixtures) {
    options.budget.reserve()
    const built = buildCompletionContinuationState(fixture.input)
    const decision = await decideCompletionContinuation({
      backend: options.backendFor(fixture), state: built.state, confidenceThreshold: CONFIDENCE_THRESHOLD,
      timeoutMs: TIMEOUT_MS, model: REQUESTED_MODEL,
    })
    if (decision.predictionStatus !== "filled" || decision.invalidAnswerCount !== 0) {
      current = artifact({ ...current, builtStateCount: options.budget.count, failedFixtureId: fixture.id,
        failureReason: decision.unavailableReason ?? "invalid_answer", callCount: options.budget.count,
        networkCallCount: options.networkCounter.value })
      await emitArtifact(options.artifactPath, current)
      return current
    }
    resolvedModel = decision.resolvedModel
    recordPredictions(matrices, fixture, decision)
    completedFixtureIds.push(fixture.id)
    current = artifact({ ...current, builtStateCount: options.budget.count, completedFixtureIds: [...completedFixtureIds],
      callCount: options.budget.count, networkCallCount: options.networkCounter.value, resolvedModel })
    await emitArtifact(options.artifactPath, current)
  }
  current = { ...current, status: "complete" }
  await emitArtifact(options.artifactPath, current)
  return current
}
async function withTempArtifact(action: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jev-w2-accuracy-"))
  try { await action(join(root, "artifact.json")) } finally { await rm(root, { recursive: true, force: true }) }
}
function matrixTotal(matrix: Matrix): number { return Object.values(matrix).flatMap((row) => Object.values(row)).reduce((sum, count) => sum + count, 0) }
describe("completion-continuation accuracy harness", () => {
  test("#given the selected default mode #when fixtures run #then a bounded mock artifact is emitted without network calls", async () => {
    if (process.env.JEV_W2_REAL_API === "1") {
      console.log("real-api opt-in acknowledged; implementation belongs to todo 18")
      return
    }
    const networkCounter = { value: 0 }
    const countingFetch = createCountingFetch(networkCounter)
    const result = Bun.argv.includes("--dry-run")
      ? await runDryRun(COMPLETION_CONTINUATION_FIXTURES, ARTIFACT_PATH)
      : await runAccuracy({ fixtures: COMPLETION_CONTINUATION_FIXTURES, artifactPath: ARTIFACT_PATH,
          budget: new RequestBudget(PAID_CALL_CEILING), networkCounter,
          backendFor: (fixture) => mockBackend(fixture, countingFetch) })
    expect(result.status).toBe("complete")
    expect(result.completedFixtureIds).toHaveLength(COMPLETION_CONTINUATION_FIXTURES.length)
    expect(result.networkCallCount).toBe(0)
    expect(networkCounter.value).toBe(0)
    expect(result.questionVersion).toBe(COMPLETION_CONTINUATION_QUESTION_VERSION)
    expect(result.byteCaps.state).toBe(24_576)
    if (result.mode === "mock") {
      expect(result.resolvedModel).toBe("mock")
      for (const question of COMPLETION_CONTINUATION_QUESTION_KEYS) expect(matrixTotal(result.confusionMatrices[question])).toBe(COMPLETION_CONTINUATION_FIXTURES.length)
    }
    console.log(`accuracy mode=${result.mode} fixtures=${result.completedFixtureIds.length} calls=${result.callCount} networkCalls=${result.networkCallCount} resolvedModel=${result.resolvedModel} questionVersion=${result.questionVersion}`)
  })
  test("#given dry-run mode #when all fixture states are built #then requests stay capped and no backend call is reserved", async () => {
    await withTempArtifact(async (path) => {
      const result = await runDryRun(COMPLETION_CONTINUATION_FIXTURES, path)
      expect(result.builtStateCount).toBe(COMPLETION_CONTINUATION_FIXTURES.length)
      expect(result.callCount).toBe(0)
      expect(result.networkCallCount).toBe(0)
      expect(COMPLETION_CONTINUATION_FIXTURES.every((fixture) => buildCompletionContinuationState(fixture.input).serializedBytes <= 24_576)).toBeTrue()
    })
  })
  test("aborts before exceeding the paid call ceiling", async () => {
    await withTempArtifact(async (path) => {
      const budget = new RequestBudget(PAID_CALL_CEILING, PAID_CALL_CEILING - 1)
      const networkCounter = { value: 0 }
      const countingFetch = createCountingFetch(networkCounter)
      let backendCalls = 0
      let observed: PaidCallCeilingError | null = null
      try {
        await runAccuracy({ fixtures: COMPLETION_CONTINUATION_FIXTURES.slice(0, 2), artifactPath: path,
          budget, networkCounter, backendFor: (fixture) => { backendCalls += 1; return mockBackend(fixture, countingFetch) } })
      } catch (error) {
        if (!(error instanceof PaidCallCeilingError)) throw error
        observed = error
      }
      expect(observed).toMatchObject({ ceiling: 18, nextOrdinal: 19 })
      expect(budget.count).toBe(PAID_CALL_CEILING)
      expect(backendCalls).toBe(1)
      expect(networkCounter.value).toBe(0)
      const retained = JSON.parse(await readFile(path, "utf8")) as HarnessArtifact
      expect(retained).toMatchObject({ status: "partial", callCount: 18 })
      expect(retained.completedFixtureIds).toHaveLength(1)
      console.log("ceiling=18 abortedBeforeCall=19 backendCalls=1 retained=1")
    })
  })
  test("#given a malformed mock answer #when scoring starts #then the retained artifact is partial", async () => {
    await withTempArtifact(async (path) => {
      const malformed = createMockDecisionBackend({
        actually_complete: { type: "noul", noul: 2 }, progressing: { type: "noul", noul: 0.5 }, stuck: { type: "noul", noul: 0.5 },
      })
      const result = await runAccuracy({ fixtures: COMPLETION_CONTINUATION_FIXTURES.slice(0, 1), artifactPath: path,
        budget: new RequestBudget(PAID_CALL_CEILING), networkCounter: { value: 0 }, backendFor: () => malformed })
      expect(result).toMatchObject({ status: "partial", failureReason: "unscripted" })
      expect(result.completedFixtureIds).toEqual([])
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(result, null, 2)}\n`)
    })
  })
  test("#given the injected no-network fetch #when invoked directly #then the tripwire fails", async () => {
    const counter = { value: 0 }
    let observed: UnexpectedNetworkCallError | null = null
    try {
      await createCountingFetch(counter)("https://invalid.example")
    } catch (error) {
      if (!(error instanceof UnexpectedNetworkCallError)) throw error
      observed = error
    }
    expect(observed).toBeInstanceOf(UnexpectedNetworkCallError)
    expect(counter.value).toBe(1)
  })
})
