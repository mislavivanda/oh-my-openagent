import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV,
  resolveCompletionContinuationAccuracyArtifactPath } from "./completion-continuation-accuracy-artifact-path"
import { COMPLETION_CONTINUATION_FIXTURES } from "./completion-continuation-fixtures"
import { COMPLETION_CONTINUATION_QUESTION_KEYS, COMPLETION_CONTINUATION_QUESTION_VERSION } from "./completion-continuation-questions"
import { buildCompletionContinuationState } from "./completion-continuation-state"
import { PAID_CALL_CEILING, PaidCallCeilingError, RequestBudget, UnexpectedNetworkCallError, createCountingFetch,
  matrixTotal, mockBackend, runAccuracy, runDryRun, withTempArtifact, type HarnessArtifact } from "./completion-continuation-accuracy-harness"
import { readRetainedRealBaseline, runMissingKeyProbe, runRealCompletionContinuationBaseline } from "./completion-continuation-accuracy-real-run"
import { createMockDecisionBackend } from "./mock-backend"
const ARTIFACT_PATH = resolveCompletionContinuationAccuracyArtifactPath({
  cwd: process.cwd(), tmpDir: tmpdir(), pid: process.pid,
  evidenceOptIn: process.env[COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV],
})
const REAL_ARTIFACT_V1_PATH = join(process.cwd(), ".omo/evidence/20260930-jev-w2/task-18-real-api-result.json")
const REAL_ARTIFACT_PATH = join(process.cwd(), `.omo/evidence/20260930-jev-w2-validity/task-7-real-api-result-v${COMPLETION_CONTINUATION_QUESTION_VERSION}.json`)
const REAL_API_REQUESTED = process.env.JEV_W2_REAL_API === "1"
const REAL_API_KEY = process.env.TYPESAFE_API_KEY?.trim() ?? ""
const REAL_TIMEOUT_MS = 15_000
const REAL_TEST_TIMEOUT_MS = 420_000
const TRANSCRIPT_TAIL_IDS = ["continue-after-red-test", "go-on-after-source-review"] as const
describe("completion-continuation accuracy harness", () => {
  test("#given the selected default mode #when fixtures run #then a bounded mock artifact is emitted without network calls", async () => {
    if (REAL_API_REQUESTED) {
      console.log("real-api opt-in acknowledged; the paid baseline runs in the real-api measurement test below")
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
    console.log(`accuracy artifact=${ARTIFACT_PATH} evidenceOptIn=${process.env[COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV] ?? "unset"}`)
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
  test("#given an interrupted run #when the artifact is inspected #then partial progress survives on disk", async () => {
    await withTempArtifact(async (path) => {
      await writeFile(path, "stale-bytes-that-must-not-survive", "utf8")
      const countingFetch = createCountingFetch({ value: 0 })
      let backendCalls = 0
      const partial = await runAccuracy({ fixtures: COMPLETION_CONTINUATION_FIXTURES.slice(0, 3), artifactPath: path,
        budget: new RequestBudget(PAID_CALL_CEILING), networkCounter: { value: 0 },
        backendFor: (fixture) => { backendCalls += 1; return backendCalls === 2 ? createMockDecisionBackend({}) : mockBackend(fixture, countingFetch) } })
      expect(partial.status).toBe("partial")
      expect(partial.completedFixtureIds).toHaveLength(1)
      const retained = JSON.parse(await readFile(path, "utf8")) as HarnessArtifact
      expect(retained.status).toBe("partial")
      console.log(`interrupted status=${retained.status} completed=${retained.completedFixtureIds.length} failedFixtureId=${retained.failedFixtureId}`)
    })
  })
  test("#given the real-api opt-in without a key #when every fixture runs #then missing_api_key is reported and no request leaves", async () => {
    if (!REAL_API_REQUESTED || REAL_API_KEY !== "") {
      console.log(`missing-key probe skipped realApiRequested=${REAL_API_REQUESTED} keyPresent=${REAL_API_KEY !== ""}`)
      return
    }
    const probe = await runMissingKeyProbe(COMPLETION_CONTINUATION_FIXTURES, REAL_TIMEOUT_MS)
    expect(probe.reasons).toHaveLength(COMPLETION_CONTINUATION_FIXTURES.length)
    expect(probe.reasons.every((reason) => reason === "missing_api_key")).toBeTrue()
    expect(probe.networkCallCount).toBe(0)
    console.log(`missing-key fixtures=${probe.reasons.length} reason=missing_api_key requests=${probe.networkCallCount} ceiling=${PAID_CALL_CEILING}`)
  })
  test("#given the real-api opt-in and a key #when each fixture runs once #then the measurement baseline is recorded without any score gate", async () => {
    if (!REAL_API_REQUESTED || REAL_API_KEY === "") {
      console.log(`real-api baseline skipped realApiRequested=${REAL_API_REQUESTED} keyPresent=${REAL_API_KEY !== ""}`)
      return
    }
    const currentVersion = await readRetainedRealBaseline(REAL_ARTIFACT_PATH)
    const retainedPath = currentVersion !== null ? REAL_ARTIFACT_PATH : REAL_ARTIFACT_V1_PATH
    const retained = currentVersion ?? await readRetainedRealBaseline(REAL_ARTIFACT_V1_PATH)
    if (retained !== null && retained.mode === "real" && process.env.JEV_W2_REAL_API_REARM !== "1") {
      expect(["complete", "partial"]).toContain(retained.status)
      expect(retained.callCount).toBeLessThanOrEqual(PAID_CALL_CEILING)
      expect(retained.networkCallCount).toBeLessThanOrEqual(PAID_CALL_CEILING)
      expect(retained.resolvedModel).not.toBe("jev-latest")
      console.log(`real-api reused-retained-baseline newSpend=0 rearmWith=JEV_W2_REAL_API_REARM=1 artifact=${retainedPath}`)
      console.log(`real-api status=${retained.status} callCount=${retained.callCount} httpRequests=${retained.networkCallCount} ceiling=${retained.callCeiling} resolvedModel=${retained.resolvedModel} questionVersion=${retained.questionVersion} completed=${retained.completedCount}`)
      console.log(retained.raw)
      return
    }
    const run = await runRealCompletionContinuationBaseline({
      apiKey: REAL_API_KEY, fixtures: COMPLETION_CONTINUATION_FIXTURES, artifactPath: REAL_ARTIFACT_PATH,
      ceiling: PAID_CALL_CEILING, timeoutMs: REAL_TIMEOUT_MS,
    })
    expect(["complete", "partial"]).toContain(run.artifact.status)
    expect(run.reservedCallCount).toBeLessThanOrEqual(PAID_CALL_CEILING)
    expect(run.networkCallCount).toBeLessThanOrEqual(PAID_CALL_CEILING)
    const perCallRequestCounts = run.detail.fixtures.map((entry) => entry.requestCount)
    console.log(`real-api status=${run.artifact.status} reservedCalls=${run.reservedCallCount} httpRequests=${run.networkCallCount} ceiling=${PAID_CALL_CEILING} timeoutMs=${REAL_TIMEOUT_MS} wallClockMs=${Math.round(run.wallClockMs)}`)
    console.log(`real-api requestedModel=${run.artifact.requestedModel} resolvedModel=${run.artifact.resolvedModel} questionVersion=${run.artifact.questionVersion} perCallRequestCounts=${JSON.stringify(perCallRequestCounts)}`)
    console.log(`real-api tokens input=${run.detail.inputTokens} output=${run.detail.outputTokens} uncertainCounts=${JSON.stringify(run.detail.uncertainCounts)}`)
    console.log(`real-api confusionMatrices=${JSON.stringify(run.artifact.confusionMatrices)}`)
    for (const entry of run.detail.fixtures) {
      console.log(`real-api fixture id=${entry.id} requests=${entry.requestCount} latencyMs=${Math.round(entry.latencyMs)} stateBytes=${entry.stateBytes} preReductionBytes=${entry.preReductionBytes} expected=${JSON.stringify(entry.expected)} predicted=${JSON.stringify(entry.thresholdLabels)} probabilities=${JSON.stringify(entry.probabilities)}`)
    }
    for (const id of TRANSCRIPT_TAIL_IDS) {
      const entry = run.detail.fixtures.find((candidate) => candidate.id === id)
      console.log(`real-api transcript-tail id=${id} present=${entry !== undefined} predicted=${JSON.stringify(entry?.thresholdLabels ?? null)} expected=${JSON.stringify(entry?.expected ?? null)}`)
    }
    if (run.artifact.status === "complete") {
      expect(run.artifact.resolvedModel).not.toBeNull()
      expect(run.detail.fixtures).toHaveLength(COMPLETION_CONTINUATION_FIXTURES.length)
      expect(run.detail.calls).toHaveLength(COMPLETION_CONTINUATION_FIXTURES.length)
    } else {
      console.log(`real-api partial failedFixtureId=${run.artifact.failedFixtureId} failureReason=${run.artifact.failureReason}`)
    }
  }, REAL_TEST_TIMEOUT_MS)
})
