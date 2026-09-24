import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { DecisionBackend, DecisionBackendDeps, DecisionOutcome, DecisionRequest, DecisionState } from "@oh-my-opencode/jev-core"
import type { IntentRoutingDecisionResult, IntentRoutingVocabulary, Questions } from "@oh-my-opencode/jev-core"
import { JevConfigSchema, type JevConfig } from "../../config/schema/jev"
import { _resetForTesting, setMainSession, subagentSessions } from "../claude-code-session-state"
import { createJevIntentRouting, isJevIntentRoutingSessionEligible, type JevIntentRoutingDispatcher } from "./intent-routing"

const MAIN_SESSION = "session-main"
const VOCAB: IntentRoutingVocabulary = {
  categories: [{ name: "quick", description: "Small focused work." }],
  subagents: [{ name: "explore", description: "Codebase reconnaissance." }],
  intents: [{ name: "implementation", description: "Write code." }],
}
const FILLED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "filled",
  truncatedInput: false,
  answers: {
    intent: { choice: "implementation", confidence: 0.9, probabilities: { implementation: 1 }, valid: true, label: "would_apply" },
    category: { choice: "quick", confidence: 0.9, probabilities: { quick: 0.9, none: 0.1 }, valid: true, label: "would_apply" },
    subagent: { choice: "none", confidence: 0.9, probabilities: { explore: 0.1, none: 0.9 }, valid: true, label: "would_apply" },
    ambiguous: { noul: 0.1, valid: true },
  },
  invalidAnswerCount: 0,
  unavailableReason: null,
  resolvedModel: "jev-test",
  latencyMs: 2,
  threshold: 0.8,
  questionVersion: 1,
}

type LogEntry = { readonly message: string; readonly data: unknown }
type ConfigOptions = Readonly<{ enabled?: boolean; wireEnabled?: boolean; backend?: "mock" | "real"; maxInflight?: number; maxPromptChars?: number }>

function config(options: ConfigOptions = {}): JevConfig {
  return JevConfigSchema.parse({
    enabled: options.enabled ?? true,
    backend: options.backend ?? "mock",
    model: "jev-test",
    wires: { intent_routing: { enabled: options.wireEnabled ?? true, max_inflight: options.maxInflight ?? 8, max_prompt_chars: options.maxPromptChars ?? 8000 } },
  })
}

function output(text: string) {
  return { parts: [{ type: "text", text }] }
}

async function runDeferredMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function realResponse(): Response {
  return new Response(JSON.stringify({
    model: "jev-test",
    answers: {
      intent: { type: "choice", choice: "implementation", confidence: 1, probabilities: { implementation: 1 } },
      category: { type: "choice", choice: "quick", confidence: 0.9, probabilities: { quick: 0.9, none: 0.1 } },
      subagent: { type: "choice", choice: "none", confidence: 0.9, probabilities: { explore: 0.1, none: 0.9 } },
      ambiguous: { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { headers: { "content-type": "application/json" } })
}

function backendCapturingState(capture: (state: DecisionState) => void): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      capture(request.state)
      return { status: "unavailable", reason: "unscripted", latencyMs: 0 }
    },
  }
}

beforeEach(() => _resetForTesting())
afterEach(() => _resetForTesting())

describe("createJevIntentRouting", () => {
  test("#given disabled config #when observing a turn #then the adapter stays disabled with zero dispatches", () => {
    const dispatcher = mock<JevIntentRoutingDispatcher>(async () => FILLED_RESULT)
    const routings = [
      createJevIntentRouting({ jevConfig: config({ enabled: false }), vocab: VOCAB, dispatcher }),
      createJevIntentRouting({ jevConfig: config({ wireEnabled: false }), vocab: VOCAB, dispatcher }),
    ]
    for (const routing of routings) {
      routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
      expect(routing.enabled).toBe(false)
    }
    expect(dispatcher).toHaveBeenCalledTimes(0)
  })

  test("#given no known main session #when observing a turn #then the fail-closed gate records main_session_unknown", () => {
    const dispatcher = mock<JevIntentRoutingDispatcher>(async () => FILLED_RESULT)
    const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB, dispatcher })
    const receipt = routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
    expect(receipt).toEqual({ predictionStatus: "not_dispatched", notDispatchedReason: "main_session_unknown" })
    expect(isJevIntentRoutingSessionEligible(MAIN_SESSION)).toBe(false)
    expect(dispatcher).toHaveBeenCalledTimes(0)
  })

  test("#given a tracked subagent session #when observing a turn #then the gate records subagent_session", () => {
    setMainSession(MAIN_SESSION)
    subagentSessions.add(MAIN_SESSION)
    const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB })
    expect(routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))).toEqual({
      predictionStatus: "not_dispatched",
      notDispatchedReason: "subagent_session",
    })
    expect(isJevIntentRoutingSessionEligible(MAIN_SESSION)).toBe(false)
  })

  test("#given an enabled main session #when observing a turn #then exactly one dispatch and one answer-shaped log occur", async () => {
    setMainSession(MAIN_SESSION)
    const entries: LogEntry[] = []
    const dispatcher = mock<JevIntentRoutingDispatcher>(async () => FILLED_RESULT)
    const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB, dispatcher, logger: (message, data) => entries.push({ message, data }) })
    routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
    await runDeferredMacrotask()
    expect(dispatcher).toHaveBeenCalledTimes(1)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe("[jev] intent-routing")
    expect(entries[0]?.data).toMatchObject({ wire: "intent_routing", sessionID: MAIN_SESSION, answers: FILLED_RESULT.answers })
    expect(entries[0]?.data).not.toHaveProperty("status")
    expect(entries[0]?.data).not.toHaveProperty("threshold")
  })

  test("#given a rejecting dispatcher #when observing #then the seam returns synchronously, logs failure, and emits no unhandled rejection", async () => {
    setMainSession(MAIN_SESSION)
    const entries: LogEntry[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB, dispatcher: async () => Promise.reject(new TypeError("dispatch failed")), logger: (message, data) => entries.push({ message, data }) })
      const receipt = routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
      expect(receipt).not.toBeInstanceOf(Promise)
      await runDeferredMacrotask()
      expect(entries[0]?.message).toBe("[jev] intent-routing failed")
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("#given max_inflight plus three turns #when dispatches never resolve #then in-flight is bounded and three are dropped", async () => {
    setMainSession(MAIN_SESSION)
    const dispatcher = mock<JevIntentRoutingDispatcher>(async () => new Promise<IntentRoutingDecisionResult>(() => {}))
    const routing = createJevIntentRouting({ jevConfig: config({ maxInflight: 2 }), vocab: VOCAB, dispatcher, logger: () => {} })
    for (let index = 0; index < 5; index += 1) routing.observe({ sessionID: MAIN_SESSION }, output(`turn ${index}`))
    await runDeferredMacrotask()
    expect(dispatcher).toHaveBeenCalledTimes(2)
    expect(routing.getStats()).toEqual({ inFlight: 2, dispatchesDropped: 3 })
  })

  test("#given a mutable output #when text changes after the seam returns #then dispatch receives the original bounded snapshot", async () => {
    setMainSession(MAIN_SESSION)
    let state: DecisionState | undefined
    const backend = backendCapturingState((nextState) => { state = nextState })
    const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB, backend, logger: () => {} })
    const mutableOutput = output("original text")
    routing.observe({ sessionID: MAIN_SESSION }, mutableOutput)
    mutableOutput.parts[0].text = "mutated text"
    await runDeferredMacrotask()
    expect(state).toEqual({ promptText: "original text", truncatedInput: false })
  })

  test("#given deferred observation #when the caller continues #then caller continuation precedes state building", async () => {
    setMainSession(MAIN_SESSION)
    const order: string[] = []
    const backend = backendCapturingState(() => order.push("state"))
    const routing = createJevIntentRouting({ jevConfig: config(), vocab: VOCAB, backend, logger: () => {} })
    routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
    await Promise.resolve()
    order.push("caller")
    await runDeferredMacrotask()
    expect(order).toEqual(["caller", "state"])
  })

  test("#given real backend env #when base URL is set then unset #then only the set case targets that origin", async () => {
    setMainSession(MAIN_SESSION)
    const calls: string[] = []
    const backendFetch: NonNullable<DecisionBackendDeps["fetch"]> = async (url) => { calls.push(String(url)); return realResponse() }
    for (const env of [{ TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: "https://local-jev.test" }, { TYPESAFE_API_KEY: "test-key" }]) {
      const routing = createJevIntentRouting({ jevConfig: config({ backend: "real" }), vocab: VOCAB, env, backendFetch, logger: () => {} })
      routing.observe({ sessionID: MAIN_SESSION }, output("implement this"))
      await runDeferredMacrotask()
    }
    expect(calls).toHaveLength(2)
    expect(calls[0]?.startsWith("https://local-jev.test/")).toBe(true)
    expect(calls[1]?.startsWith("https://local-jev.test/")).toBe(false)
  })

  test("#given a max_prompt_chars prompt #when measuring the synchronous seam #then p99 stays below one millisecond", () => {
    setMainSession(MAIN_SESSION)
    const routing = createJevIntentRouting({ jevConfig: config({ maxInflight: 64 }), vocab: VOCAB, dispatcher: async () => FILLED_RESULT, logger: () => {} })
    const longOutput = output("x".repeat(8000))
    const samples: number[] = []
    for (let index = 0; index < 200; index += 1) {
      const startedAt = performance.now()
      routing.observe({ sessionID: MAIN_SESSION }, longOutput)
      samples.push(performance.now() - startedAt)
    }
    samples.sort((left, right) => left - right)
    const p99 = samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY
    console.log(`intent-routing synchronous p99: ${p99.toFixed(3)}ms`)
    expect(p99).toBeLessThan(1)
  })
})
