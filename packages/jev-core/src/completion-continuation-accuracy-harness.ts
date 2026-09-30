import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { selectDecisionBackend } from "./backend-selector"
import { decideCompletionContinuation, type CompletionContinuationDecisionResult } from "./completion-continuation"
import type { CompletionContinuationFixture } from "./completion-continuation-fixtures"
import { COMPLETION_CONTINUATION_QUESTION_KEYS, COMPLETION_CONTINUATION_QUESTION_VERSION, type CompletionContinuationQuestionKey } from "./completion-continuation-questions"
import type { CompletionContinuationProbabilities, CompletionContinuationThresholdLabels } from "./completion-continuation-record-types"
import { COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES, COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES, COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES, buildCompletionContinuationState } from "./completion-continuation-state"
import type { DecisionBackend, RealDecisionBackendDeps } from "./index"
export const PAID_CALL_CEILING = 18
export const CONFIDENCE_THRESHOLD = 0.8
export const TIMEOUT_MS = 2_500
export const REQUESTED_MODEL = "jev-latest"
export const BYTE_CAPS = {
  state: COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  todoContent: COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  transcript: COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  diffPaths: COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
} as const
export type MutableCounter = { value: number }
export type BackendFetch = NonNullable<RealDecisionBackendDeps["fetch"]>
export type Matrix = Record<string, Record<string, number>>
export type Matrices = Record<CompletionContinuationQuestionKey, Matrix>
export type HarnessCallDetail = {
  readonly resolvedModel: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly backendLatencyMs: number
}
export type HarnessFixtureDetail = {
  readonly id: string
  readonly cohorts: readonly string[]
  readonly stateBytes: number
  readonly preReductionBytes: number
  readonly requestCount: number
  readonly latencyMs: number
  readonly resolvedModel: string | null
  readonly expected: Record<CompletionContinuationQuestionKey, string>
  readonly probabilities: CompletionContinuationProbabilities
  readonly thresholdLabels: CompletionContinuationThresholdLabels
}
/** Mutable collector shared with the caller so a partial artifact keeps every per-call fact. */
export type HarnessDetail = {
  readonly timeoutMs: number
  readonly fixtures: HarnessFixtureDetail[]
  readonly calls: HarnessCallDetail[]
  readonly uncertainCounts: Record<CompletionContinuationQuestionKey, number>
  inputTokens: number
  outputTokens: number
}
export type HarnessArtifact = {
  readonly status: "complete" | "partial"
  readonly mode: "mock" | "dry-run" | "real"
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
  readonly detail?: HarnessDetail
}
export type RunOptions = {
  readonly fixtures: readonly CompletionContinuationFixture[]
  readonly artifactPath: string
  readonly budget: RequestBudget
  readonly networkCounter: MutableCounter
  readonly backendFor: (fixture: CompletionContinuationFixture) => DecisionBackend
  readonly mode?: "mock" | "real"
  readonly timeoutMs?: number
  readonly detail?: HarnessDetail
}
export class PaidCallCeilingError extends Error {
  readonly name = "PaidCallCeilingError"
  constructor(readonly ceiling: number, readonly nextOrdinal: number) {
    super(`Paid call ceiling ${ceiling} reached before call ${nextOrdinal}`)
  }
}
export class UnexpectedNetworkCallError extends Error {
  readonly name = "UnexpectedNetworkCallError"
  constructor() { super("Mock completion-continuation harness attempted fetch") }
}
/** Mutable request budget whose purpose is to reserve paid calls before dispatch. */
export class RequestBudget {
  constructor(readonly ceiling: number, private used = 0) {}
  reserve(): void {
    if (this.used >= this.ceiling) throw new PaidCallCeilingError(this.ceiling, this.used + 1)
    this.used += 1
  }
  get count(): number { return this.used }
}
export function createCountingFetch(counter: MutableCounter): BackendFetch {
  return async () => {
    counter.value += 1
    throw new UnexpectedNetworkCallError()
  }
}
/** Counts every HTTP attempt and then forwards it, so a paid run measures its own request count. */
export function createForwardingCountingFetch(counter: MutableCounter): BackendFetch {
  return async (input, init) => {
    counter.value += 1
    return fetch(input, init)
  }
}
export function createMatrices(): Matrices { return { actually_complete: {}, progressing: {}, stuck: {} } }
export function createDetail(timeoutMs: number): HarnessDetail {
  return {
    timeoutMs, fixtures: [], calls: [],
    uncertainCounts: { actually_complete: 0, progressing: 0, stuck: 0 },
    inputTokens: 0, outputTokens: 0,
  }
}
export function mockBackend(fixture: CompletionContinuationFixture, countingFetch: BackendFetch): DecisionBackend {
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
export function expectedLabels(fixture: CompletionContinuationFixture): Record<CompletionContinuationQuestionKey, string> {
  return {
    actually_complete: String(fixture.label.actuallyComplete),
    progressing: String(fixture.label.progressing),
    stuck: String(fixture.label.stuck),
  }
}
export function recordPredictions(matrices: Matrices, fixture: CompletionContinuationFixture, result: CompletionContinuationDecisionResult): void {
  const actual = expectedLabels(fixture)
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
export async function emitArtifact(path: string, artifactValue: HarnessArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const pending = `${path}.${process.pid}.tmp`
  await writeFile(pending, `${JSON.stringify(artifactValue, null, 2)}\n`, "utf8")
  await rename(pending, path)
}
export function artifact(args: Omit<HarnessArtifact, "fixtureCount" | "callCeiling" | "questionVersion" | "byteCaps"> & { readonly fixtureCount: number }): HarnessArtifact {
  return { ...args, callCeiling: PAID_CALL_CEILING, questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION, byteCaps: BYTE_CAPS }
}
export async function runDryRun(fixtures: readonly CompletionContinuationFixture[], path: string): Promise<HarnessArtifact> {
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
function countUncertain(detail: HarnessDetail, labels: CompletionContinuationThresholdLabels): void {
  if (labels.actuallyComplete === "uncertain") detail.uncertainCounts.actually_complete += 1
  if (labels.progressing === "uncertain") detail.uncertainCounts.progressing += 1
  if (labels.stuck === "uncertain") detail.uncertainCounts.stuck += 1
}
export async function runAccuracy(options: RunOptions): Promise<HarnessArtifact> {
  const completedFixtureIds: string[] = []
  const matrices = createMatrices()
  const mode = options.mode ?? "mock"
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let resolvedModel: string | null = null
  let current = artifact({
    status: "partial", mode, fixtureCount: options.fixtures.length, builtStateCount: 0,
    completedFixtureIds, failedFixtureId: null, failureReason: null, callCount: options.budget.count,
    networkCallCount: options.networkCounter.value, requestedModel: REQUESTED_MODEL, resolvedModel,
    confusionMatrices: matrices, detail: options.detail,
  })
  await emitArtifact(options.artifactPath, current)
  for (const fixture of options.fixtures) {
    options.budget.reserve()
    const built = buildCompletionContinuationState(fixture.input)
    const requestsBefore = options.networkCounter.value
    const decision = await decideCompletionContinuation({
      backend: options.backendFor(fixture), state: built.state, confidenceThreshold: CONFIDENCE_THRESHOLD,
      timeoutMs, model: REQUESTED_MODEL,
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
    options.detail?.fixtures.push({
      id: fixture.id, cohorts: fixture.cohorts, stateBytes: built.serializedBytes,
      preReductionBytes: built.preReductionBytes, requestCount: options.networkCounter.value - requestsBefore,
      latencyMs: decision.latencyMs, resolvedModel: decision.resolvedModel, expected: expectedLabels(fixture),
      probabilities: decision.probabilities, thresholdLabels: decision.thresholdLabels,
    })
    if (options.detail !== undefined) countUncertain(options.detail, decision.thresholdLabels)
    completedFixtureIds.push(fixture.id)
    current = artifact({ ...current, builtStateCount: options.budget.count, completedFixtureIds: [...completedFixtureIds],
      callCount: options.budget.count, networkCallCount: options.networkCounter.value, resolvedModel })
    await emitArtifact(options.artifactPath, current)
  }
  current = { ...current, status: "complete" }
  await emitArtifact(options.artifactPath, current)
  return current
}
export async function withTempArtifact(action: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jev-w2-accuracy-"))
  try { await action(join(root, "artifact.json")) } finally { await rm(root, { recursive: true, force: true }) }
}
export function matrixTotal(matrix: Matrix): number { return Object.values(matrix).flatMap((row) => Object.values(row)).reduce((sum, count) => sum + count, 0) }
