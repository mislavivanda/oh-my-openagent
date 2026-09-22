import { describe, expect, test } from "bun:test"
import type { Fetch } from "@typesafe-ai/sdk"
import { resolve } from "node:path"
import { isRecord } from "./answer-validation"
import { createRealDecisionBackend } from "./real-backend"
import type { Questions } from "./types"

const API_KEY = "jev-test-secret"
const MODEL = "jev-1.13.0"
const BASE_URL = "https://jev.test"

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

const validAnswer = {
  type: "choice",
  choice: "retry",
  probabilities: { retry: 0.9, stop: 0.05, ignore: 0.05 },
  confidence: 0.9,
}

const validBody = {
  model: MODEL,
  answers: { triage: validAnswer },
  usage: { input_tokens: 17, output_tokens: 5 },
}

type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

function createJsonFetch(body: unknown, status = 200): {
  readonly fetch: Fetch
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetch, calls }
}

function createBackend(fetch: Fetch, apiKey: string | undefined = API_KEY, timeoutMs = 1_000) {
  return createRealDecisionBackend({ apiKey, model: MODEL, timeoutMs, fetch, baseURL: BASE_URL })
}

describe("createRealDecisionBackend", () => {
  test("#given case (1) a missing API key #when deciding #then it is unavailable without fetching", async () => {
    const fake = createJsonFetch(validBody)
    const backend = createRealDecisionBackend({
      apiKey: undefined,
      model: MODEL,
      timeoutMs: 1_000,
      fetch: fake.fetch,
      baseURL: BASE_URL,
    })

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "missing_api_key" })
    expect(fake.calls).toHaveLength(0)
  })

  test("#given case (2) a wire-shaped 200 response #when deciding #then it returns the decision and sends the authenticated request", async () => {
    const fake = createJsonFetch(validBody)
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: { error: "overloaded" }, questions })

    expect(outcome.status).toBe("decided")
    if (outcome.status !== "decided") {
      throw new Error("Expected a decided real-backend outcome")
    }
    expect(outcome.answers.triage.choice).toBe("retry")
    expect(outcome.model).toBe(MODEL)
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call.init?.method).toBe("POST")
    expect(call.url.endsWith("/v1/systemone")).toBe(true)
    expect(new Headers(call.init?.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`)
    expect(typeof call.init?.body).toBe("string")
    if (typeof call.init?.body !== "string") {
      throw new Error("Expected a JSON request body")
    }
    const requestBody: unknown = JSON.parse(call.init.body)
    expect(isRecord(requestBody)).toBe(true)
    if (!isRecord(requestBody)) {
      throw new Error("Expected a request-body record")
    }
    expect(requestBody.model).toBe(MODEL)
  })

  test("#given case (3) a 429 response #when deciding #then it is an API error with no retry", async () => {
    const fake = createJsonFetch({ error: { message: "rate limited" } }, 429)
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "api_error" })
    if (outcome.status !== "unavailable") {
      throw new Error("Expected an unavailable API-error outcome")
    }
    expect(outcome.detail).toContain("429")
    expect(fake.calls).toHaveLength(1)
  })

  test("#given case (4) a fetch TypeError #when deciding #then it is a transport error without retry", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      throw new TypeError("fetch failed")
    }
    const backend = createBackend(fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "transport_error" })
    expect(calls).toBe(1)
  })

  test("#given case (5) a fetch pending past 50ms #when the SDK aborts it #then it is a timeout", async () => {
    let calls = 0
    const fetch: Fetch = async (_url, init) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new TypeError("Expected the SDK to provide an abort signal"))
          return
        }
        const abort = () => reject(new DOMException("The operation was aborted", "AbortError"))
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener("abort", abort, { once: true })
      })
    }
    const backend = createBackend(fetch, API_KEY, 50)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "timeout" })
    expect(calls).toBe(1)
  })

  test("#given case (6) a response missing the triage answer #when deciding #then it is malformed", async () => {
    const fake = createJsonFetch({ ...validBody, answers: {} })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response", detail: "triage" })
  })

  test("#given case (7) a response choice outside the criteria #when deciding #then it is malformed", async () => {
    const fake = createJsonFetch({
      ...validBody,
      answers: { triage: { ...validAnswer, choice: "later" } },
    })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response", detail: "triage" })
  })

  test("#given case (7b) empty probabilities #when deciding #then the nested answer is malformed", async () => {
    const fake = createJsonFetch({
      ...validBody,
      answers: { triage: { ...validAnswer, probabilities: {} } },
    })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response", detail: "triage" })
  })

  test("#given case (7b) a non-numeric probability #when deciding #then the nested answer is malformed", async () => {
    const fake = createJsonFetch({
      ...validBody,
      answers: {
        triage: {
          ...validAnswer,
          probabilities: { retry: "0.9", stop: 0.05, ignore: 0.05 },
        },
      },
    })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response", detail: "triage" })
  })

  test("#given case (7b) confidence above one #when deciding #then the nested answer is malformed", async () => {
    const fake = createJsonFetch({
      ...validBody,
      answers: { triage: { ...validAnswer, confidence: 1.5 } },
    })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response", detail: "triage" })
  })

  test("#given case (7c) a 401 body echoing the key #when deciding #then the API detail is redacted and bounded", async () => {
    const key = "api-error-secret"
    const fake = createJsonFetch({ error: { message: `invalid key ${key}` } }, 401)
    const backend = createBackend(fake.fetch, key)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "api_error" })
    if (outcome.status !== "unavailable" || outcome.detail === undefined) {
      throw new Error("Expected an unavailable API-error detail")
    }
    expect(outcome.detail.startsWith("status 401:")).toBe(true)
    expect(outcome.detail).toContain("<redacted>")
    expect(outcome.detail).not.toContain(key)
    expect(outcome.detail.length).toBeLessThanOrEqual(200)
  })

  test("#given case (7c) a transport message echoing the key #when deciding #then the transport detail is redacted", async () => {
    const key = "transport-error-secret"
    const fetch: Fetch = async () => {
      throw new TypeError(`fetch failed for Bearer ${key}`)
    }
    const backend = createBackend(fetch, key)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "transport_error" })
    if (outcome.status !== "unavailable" || outcome.detail === undefined) {
      throw new Error("Expected an unavailable transport-error detail")
    }
    expect(outcome.detail).toContain("<redacted>")
    expect(outcome.detail).not.toContain(key)
  })

  test("#given case (8) no SDK key in a fresh process #when importing the backend #then import performs no fetch", () => {
    const env = { ...process.env }
    delete env.TYPESAFE_API_KEY
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'globalThis.fetch = () => { throw new Error("fetch called at import") }; await import(process.argv[1]); console.log("IMPORT_OK")',
        resolve(import.meta.dir, "real-backend.ts"),
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    )

    expect(probe.exitCode).toBe(0)
    expect(probe.stdout.toString()).toContain("IMPORT_OK")
  })

  test("#given case (9) a response missing usage #when deciding #then it is malformed", async () => {
    const fake = createJsonFetch({ model: MODEL, answers: { triage: validAnswer } })
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response" })
  })

  test("#given case (9) a null response body #when deciding #then it is malformed without throwing", async () => {
    const fake = createJsonFetch(null)
    const backend = createBackend(fake.fetch)

    const outcome = await backend.decide({ state: null, questions })

    expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed_response" })
  })
})
