import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PaidCallCeilingError, createForwardingCountingFetch } from "./completion-continuation-accuracy-harness"
import { runRealCompletionContinuationBaseline, type RealBaselineOptions } from "./completion-continuation-accuracy-real-run"
import { COMPLETION_CONTINUATION_FIXTURES } from "./completion-continuation-fixtures"

/**
 * Drives the paid orchestration against a LOCAL fake systemOne endpoint. It proves the
 * request counter, the hard ceiling, the hard timeout and the malformed class on exactly the
 * code the budgeted run uses, at zero cost. The live paid endpoint is never contacted.
 */
type ServerMode = "ok" | "slow" | "malformed"

const SANDBOX_CREDENTIAL = "sandbox-dummy-not-a-real-credential"
const THREE = COMPLETION_CONTINUATION_FIXTURES.slice(0, 3)
let serverRequests = 0
let mode: ServerMode = "ok"
let server: ReturnType<typeof Bun.serve> | null = null
let baseURL = ""
let root = ""

function sandboxOptions(overrides: {
  readonly fixtures: readonly (typeof COMPLETION_CONTINUATION_FIXTURES)[number][]
  readonly artifactPath: string
  readonly ceiling: number
  readonly timeoutMs: number
}): RealBaselineOptions {
  return { ...overrides, ["apiKey"]: SANDBOX_CREDENTIAL, baseURL }
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      serverRequests += 1
      if (new URL(request.url).pathname !== "/v1/systemone") return new Response("not found", { status: 404 })
      await request.text()
      if (mode === "slow") await Bun.sleep(1_500)
      if (mode === "malformed") {
        return Response.json({ model: "fake-jev-9.9.9", usage: { input_tokens: 1, output_tokens: 1 } })
      }
      return Response.json({
        answers: {
          actually_complete: { type: "noul", noul: 0.9 },
          progressing: { type: "noul", noul: 0.2 },
          stuck: { type: "noul", noul: 0.1 },
        },
        model: "fake-jev-9.9.9",
        usage: { input_tokens: 11, output_tokens: 3 },
      })
    },
  })
  baseURL = `http://127.0.0.1:${server.port}`
  root = await mkdtemp(join(tmpdir(), "jev-w2-real-run-"))
})

afterAll(async () => {
  server?.stop(true)
  server = null
  await rm(root, { recursive: true, force: true })
})

describe("completion-continuation real-run orchestration against a local fake endpoint", () => {
  test("#given three fixtures #when the paid orchestration runs #then one HTTP request is issued per three-question call", async () => {
    mode = "ok"
    serverRequests = 0
    const run = await runRealCompletionContinuationBaseline(sandboxOptions({
      fixtures: THREE, artifactPath: join(root, "a.json"), ceiling: 18, timeoutMs: 5_000,
    }))
    expect(run.artifact.status).toBe("complete")
    expect(run.reservedCallCount).toBe(3)
    expect(run.networkCallCount).toBe(3)
    expect(serverRequests).toBe(run.networkCallCount)
    expect(run.detail.fixtures.map((entry) => entry.requestCount)).toEqual([1, 1, 1])
    expect(run.artifact.resolvedModel).toBe("fake-jev-9.9.9")
    expect(run.detail.inputTokens).toBe(33)
    expect(run.detail.outputTokens).toBe(9)
    console.log(`A orchestrated status=${run.artifact.status} reserved=${run.reservedCallCount} clientCount=${run.networkCallCount} serverCount=${serverRequests} perCallRequests=${JSON.stringify(run.detail.fixtures.map((entry) => entry.requestCount))} tokensIn=${run.detail.inputTokens} tokensOut=${run.detail.outputTokens} resolvedModel=${run.artifact.resolvedModel}`)
    console.log(`A verdict clientEqualsServer=${run.networkCallCount === serverRequests} oneRequestPerThreeQuestionCall=${run.detail.fixtures.every((entry) => entry.requestCount === 1)}`)
  })

  test("#given forced extra attempts #when they go through the counting fetch #then the counter rises with the server count", async () => {
    mode = "ok"
    serverRequests = 0
    const counter = { value: 0 }
    const countingFetch = createForwardingCountingFetch(counter)
    await countingFetch(`${baseURL}/v1/systemone`, { method: "POST", body: "{}" })
    expect(counter.value).toBe(1)
    expect(serverRequests).toBe(1)
    console.log(`B forcedExtraCall counter=${counter.value} serverCount=${serverRequests} rose=${counter.value === 1}`)
    await countingFetch(`${baseURL}/v1/systemone`, { method: "POST", body: "{}" })
    expect(counter.value).toBe(2)
    expect(serverRequests).toBe(2)
    console.log(`B secondForcedCall counter=${counter.value} serverCount=${serverRequests} rose=${counter.value === 2}`)
  })

  test("#given a ceiling below the fixture count #when the budget runs out #then the run aborts and keeps a partial artifact", async () => {
    mode = "ok"
    serverRequests = 0
    const artifactPath = join(root, "c.json")
    let observed: PaidCallCeilingError | null = null
    try {
      await runRealCompletionContinuationBaseline(sandboxOptions({
        fixtures: THREE, artifactPath, ceiling: 2, timeoutMs: 5_000,
      }))
    } catch (error) {
      if (!(error instanceof PaidCallCeilingError)) throw error
      observed = error
    }
    expect(observed).toMatchObject({ name: "PaidCallCeilingError", ceiling: 2, nextOrdinal: 3 })
    expect(serverRequests).toBe(2)
    const retained: unknown = JSON.parse(await readFile(artifactPath, "utf8"))
    expect(retained).toMatchObject({ status: "partial", mode: "real", callCount: 2 })
    console.log(`C ceilingAbort error=${observed?.name} nextOrdinal=${observed?.nextOrdinal} serverCount=${serverRequests} retainedStatus=partial retainedCallCount=2`)
  })

  test("#given an endpoint slower than the deadline #when the call runs #then the hard timeout ends it and the artifact stays partial", async () => {
    mode = "slow"
    serverRequests = 0
    const startedAt = performance.now()
    const run = await runRealCompletionContinuationBaseline(sandboxOptions({
      fixtures: THREE.slice(0, 1), artifactPath: join(root, "d.json"), ceiling: 18, timeoutMs: 300,
    }))
    const elapsedMs = performance.now() - startedAt
    expect(run.artifact).toMatchObject({ status: "partial", failureReason: "timeout" })
    expect(serverRequests).toBe(1)
    console.log(`D hardTimeout status=${run.artifact.status} failureReason=${run.artifact.failureReason} elapsedMs=${Math.round(elapsedMs)} timeoutMs=300 serverCount=${serverRequests}`)
  })

  test("#given a malformed live response #when it is validated #then the run is partial with malformed_response", async () => {
    mode = "malformed"
    serverRequests = 0
    const run = await runRealCompletionContinuationBaseline(sandboxOptions({
      fixtures: THREE.slice(0, 1), artifactPath: join(root, "e.json"), ceiling: 18, timeoutMs: 5_000,
    }))
    expect(run.artifact).toMatchObject({ status: "partial", failureReason: "malformed_response" })
    expect(run.artifact.completedFixtureIds).toEqual([])
    expect(serverRequests).toBe(1)
    console.log(`E malformedResponse status=${run.artifact.status} failureReason=${run.artifact.failureReason} completed=${JSON.stringify(run.artifact.completedFixtureIds)} serverCount=${serverRequests}`)
  })
})
