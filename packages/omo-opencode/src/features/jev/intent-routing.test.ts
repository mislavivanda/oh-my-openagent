// allow: SIZE_OK - execution-model acceptance requires one consolidated adapter suite; production code stays split at its real seams.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  choiceAnswer,
  createMockDecisionBackend,
  type DecisionBackend,
  type DecisionBackendDeps,
  type DecisionOutcome,
  type DecisionRequest,
  type IntentRoutingDecisionResult,
  type IntentRoutingEntry,
  type Questions,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema, type JevConfig } from "../../config/schema/jev"
import {
  _resetForTesting,
  setMainSession,
  subagentSessions,
} from "../claude-code-session-state/state"
import {
  createJevIntentRouting,
  isJevIntentRoutingSessionEligible,
} from "./intent-routing"

const SESSION_ID = "main-session"
const MAX_PROMPT_CHARS = 8_000
const OVERRIDE_ORIGIN = "https://jev.local.test"
const DEFAULT_ORIGIN = "https://api.typesafe.ai"

const VOCABULARY = {
  categories: [
    { name: "deep", description: "Autonomous multi-step problem solving." },
    { name: "quick", description: "Small, direct changes." },
  ],
  subagents: [
    { name: "explore", description: "Repository exploration." },
    { name: "librarian", description: "External documentation research." },
  ],
  intents: [
    { name: "research", description: "Research or understanding." },
    { name: "implementation", description: "Explicit implementation." },
  ],
} as const

const ANSWERS = {
  intent: choiceAnswer("implementation", 0.9, ["research", "implementation"]),
  category: choiceAnswer("deep", 0.9, ["deep", "quick", "none"]),
  subagent: choiceAnswer("none", 0.9, ["explore", "librarian", "none"]),
  ambiguous: { type: "noul", noul: 0.1 } as const,
}

const FILLED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "filled",
  unavailableReason: null,
  resolvedModel: "jev-intent-test",
  latencyMs: 1,
  truncatedInput: false,
  answers: {
    intent: { choice: "implementation", confidence: 0.9, probabilities: { research: 0.1, implementation: 0.9 }, valid: true },
    category: { choice: "deep", confidence: 0.9, probabilities: { deep: 0.9, quick: 0.05, none: 0.05 }, valid: true },
    subagent: { choice: "none", confidence: 0.9, probabilities: { explore: 0.05, librarian: 0.05, none: 0.9 }, valid: true },
    ambiguous: { noul: 0.1, valid: true },
  },
  labels: {
    intent: "would_apply",
    category: "would_apply",
    subagent: "would_apply",
  },
  invalidAnswerCount: 0,
  questionVersion: 1,
}

const TEST_SINK = {
  processId: "intent-routing-test",
  filePath: "/tmp/intent-routing-test.jsonl",
  counterEpoch: 0,
  write: () => true,
  dispose: () => {},
}

function createTestJevIntentRouting(
  args: Parameters<typeof createJevIntentRouting>[0],
): ReturnType<typeof createJevIntentRouting> {
  return createJevIntentRouting({ ...args, sink: TEST_SINK })
}

type LogEntry = {
  readonly message: string
  readonly data: unknown
}

function enabledConfig(overrides: { readonly maxInflight?: number; readonly backend?: "mock" | "real" } = {}): JevConfig {
  return JevConfigSchema.parse({
    enabled: true,
    backend: overrides.backend ?? "mock",
    model: "jev-intent-test",
    wires: {
      intent_routing: {
        enabled: true,
        max_inflight: overrides.maxInflight ?? 8,
        max_prompt_chars: MAX_PROMPT_CHARS,
      },
    },
  })
}

function logCollector(): {
  readonly entries: LogEntry[]
  readonly logger: (message: string, data?: unknown) => void
} {
  const entries: LogEntry[] = []
  return {
    entries,
    logger(message, data) {
      entries.push({ message, data })
    },
  }
}

function turn(text: string, sessionID = SESSION_ID): {
  readonly input: { readonly sessionID: string }
  readonly output: { readonly parts: Array<{ type: string; text?: string }> }
} {
  return {
    input: { sessionID },
    output: { parts: [{ type: "text", text }] },
  }
}

async function settleDeferredDispatch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
  await Promise.resolve()
}

function validRealResponse(): Response {
  return new Response(JSON.stringify({
    model: "jev-intent-test",
    answers: ANSWERS,
    usage: { input_tokens: 10, output_tokens: 4 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  _resetForTesting()
})

afterEach(() => {
  _resetForTesting()
})

describe("createJevIntentRouting", () => {
  test("#given disabled config #when a turn arrives #then enabled is false and zero dispatches occur", async () => {
    const dispatcher = mock(async () => FILLED_RESULT)
    const routing = createTestJevIntentRouting({
      jevConfig: JevConfigSchema.parse({
        enabled: false,
        wires: { intent_routing: { enabled: true } },
      }),
      vocab: VOCABULARY,
      dispatcher,
    })

    const currentTurn = turn("Implement routing")
    routing.dispatch(currentTurn.input, currentTurn.output)
    await settleDeferredDispatch()

    expect(routing.enabled).toBe(false)
    expect(dispatcher).toHaveBeenCalledTimes(0)
    expect(routing.inFlight).toBe(0)
    expect(routing.dispatchesDropped).toBe(0)
  })

  test("#given no known main session #when a turn arrives #then the gate fails closed with a recorded reason", async () => {
    const logs = logCollector()
    const dispatcher = mock(async () => FILLED_RESULT)
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      dispatcher,
      logger: logs.logger,
    })

    const currentTurn = turn("Unknown provenance")
    routing.dispatch(currentTurn.input, currentTurn.output)
    await settleDeferredDispatch()

    expect(isJevIntentRoutingSessionEligible(SESSION_ID)).toBe(false)
    expect(dispatcher).toHaveBeenCalledTimes(0)
    expect(logs.entries).toHaveLength(1)
    expect(logs.entries[0]?.data).toMatchObject({
      predictionStatus: "not_dispatched",
      notDispatchedReason: "main_session_unknown",
      sessionID: SESSION_ID,
    })
  })

  test("#given a registered subagent session #when a turn arrives #then it is not dispatched", async () => {
    setMainSession(SESSION_ID)
    subagentSessions.add(SESSION_ID)
    const logs = logCollector()
    const dispatcher = mock(async () => FILLED_RESULT)
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      dispatcher,
      logger: logs.logger,
    })

    const currentTurn = turn("Subagent turn")
    routing.dispatch(currentTurn.input, currentTurn.output)
    await settleDeferredDispatch()

    expect(isJevIntentRoutingSessionEligible(SESSION_ID)).toBe(false)
    expect(dispatcher).toHaveBeenCalledTimes(0)
    expect(logs.entries[0]?.data).toMatchObject({
      predictionStatus: "not_dispatched",
      notDispatchedReason: "subagent_session",
    })
  })

  test("#given an enabled main session #when a turn arrives #then exactly one decision and one nested-answer log are produced", async () => {
    setMainSession(SESSION_ID)
    const logs = logCollector()
    const backend = createMockDecisionBackend(ANSWERS, { model: "jev-intent-test" })
    const decide = mock(backend.decide.bind(backend))
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      backend: { kind: backend.kind, decide },
      logger: logs.logger,
    })

    const currentTurn = turn("Implement routing")
    routing.dispatch(currentTurn.input, currentTurn.output)
    await settleDeferredDispatch()

    expect(decide).toHaveBeenCalledTimes(1)
    expect(logs.entries).toHaveLength(1)
    expect(logs.entries[0]?.message).toBe("[jev] intent-routing")
    expect(logs.entries[0]?.data).toMatchObject({
      wire: "intent_routing",
      predictionStatus: "filled",
      answers: {
        intent: { choice: "implementation" },
        category: { choice: "deep" },
        subagent: { choice: "none" },
        ambiguous: { noul: 0.1 },
      },
    })
    expect(logs.entries[0]?.data).not.toHaveProperty("status")
    expect(logs.entries[0]?.data).not.toHaveProperty("threshold")
  })

  test("#given a rejecting dispatcher #when a turn arrives #then the seam returns synchronously, logs failure, and emits no unhandled rejection", async () => {
    setMainSession(SESSION_ID)
    const logs = logCollector()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    const dispatcher = mock(async (): Promise<IntentRoutingDecisionResult> => {
      throw new TypeError("dispatcher rejected")
    })
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      dispatcher,
      logger: logs.logger,
    })

    process.on("unhandledRejection", onUnhandled)
    try {
      const currentTurn = turn("Reject safely")
      const returned = routing.dispatch(currentTurn.input, currentTurn.output)
      expect(returned).toBeUndefined()
      expect(dispatcher).toHaveBeenCalledTimes(0)

      await settleDeferredDispatch()
      await settleDeferredDispatch()

      expect(dispatcher).toHaveBeenCalledTimes(1)
      expect(logs.entries).toHaveLength(1)
      expect(logs.entries[0]?.message).toBe("[jev] intent-routing failed")
      expect(logs.entries[0]?.data).toMatchObject({
        wire: "intent_routing",
        sessionID: SESSION_ID,
        error: "TypeError: dispatcher rejected",
      })
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("#given max_inflight plus three turns and a never-resolving dispatcher #when timers run #then in-flight work is bounded and three dispatches drop", async () => {
    setMainSession(SESSION_ID)
    const maxInflight = 4
    const dispatcher = mock(() => new Promise<IntentRoutingDecisionResult>(() => {}))
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig({ maxInflight }),
      vocab: VOCABULARY,
      dispatcher,
      logger: () => {},
    })

    for (let index = 0; index < maxInflight + 3; index += 1) {
      const currentTurn = turn(`Turn ${index}`)
      routing.dispatch(currentTurn.input, currentTurn.output)
    }
    await settleDeferredDispatch()

    expect(dispatcher).toHaveBeenCalledTimes(maxInflight)
    expect(routing.inFlight).toBe(maxInflight)
    expect(routing.dispatchesDropped).toBe(3)
  })

  test("#given live eligible gated synthetic resume unknown and dropped turns #when final counters flush #then all six measured counters are non-zero", async () => {
    setMainSession(SESSION_ID)
    const entries: IntentRoutingEntry[] = []
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig({ maxInflight: 1 }),
      vocab: VOCABULARY,
      dispatcher: () => new Promise<IntentRoutingDecisionResult>(() => {}),
      logger: () => {},
      sink: {
        processId: "counter-threading-test",
        filePath: "/tmp/counter-threading-test.jsonl",
        counterEpoch: 0,
        write(entry) {
          entries.push(entry)
          return true
        },
        dispose() {},
      },
    })

    const first = turn("First live turn")
    routing.dispatch(first.input, first.output)
    await settleDeferredDispatch()
    expect(routing.capture(
      { tool: "task", sessionID: SESSION_ID, callID: "resume-call" },
      { args: { task_id: "ses-child" } },
    )).toBe(true)
    expect(routing.capture(
      { tool: "task", sessionID: SESSION_ID, callID: "unknown-call" },
      { args: { category: "legacy-category" } },
    )).toBe(true)

    const dropped = turn("Dropped live turn")
    routing.dispatch(dropped.input, dropped.output)
    routing.dispatch(
      { sessionID: SESSION_ID },
      { parts: [{ type: "text", text: "internal", synthetic: true }] },
    )
    const gated = turn("Gated turn", "other-session")
    routing.dispatch(gated.input, gated.output)
    await settleDeferredDispatch()
    await routing.dispose()

    const latest = entries.filter((entry) => entry.kind === "counter_delta").at(-1)
    expect(latest?.counters).toMatchObject({
      turnsSeen: 4,
      turnsGatedOut: 1,
      turnsSynthetic: 1,
      unscorableResumeCalls: 1,
      unscorableUnknownCalls: 1,
      dispatchesDropped: 2,
    })
  })

  test("#given mutable output parts #when they change immediately after dispatch #then the backend state keeps the original bounded snapshot", async () => {
    setMainSession(SESSION_ID)
    const called = Promise.withResolvers<void>()
    let capturedState: DecisionRequest<Questions>["state"] | undefined
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
        capturedState = request.state
        called.resolve()
        return { status: "unavailable", reason: "unscripted", latencyMs: 0 }
      },
    }
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      backend,
      logger: () => {},
    })
    const currentTurn = turn("Original user text")

    routing.dispatch(currentTurn.input, currentTurn.output)
    currentTurn.output.parts[0] = { type: "text", text: "Mutated hook text" }
    await called.promise

    expect(capturedState).toEqual({
      prompt_text: "Original user text",
      truncated_input: false,
    })
  })

  test("#given an enabled turn #when the caller continues #then its continuation runs before state building begins", async () => {
    setMainSession(SESSION_ID)
    const order: string[] = []
    const called = Promise.withResolvers<void>()
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        order.push("state-built")
        called.resolve()
        return { status: "unavailable", reason: "unscripted", latencyMs: 0 }
      },
    }
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig(),
      vocab: VOCABULARY,
      backend,
      logger: () => {},
    })
    const currentTurn = turn("Defer this work")

    routing.dispatch(currentTurn.input, currentTurn.output)
    await Promise.resolve()
    order.push("caller-continuation")
    await called.promise

    expect(order).toEqual(["caller-continuation", "state-built"])
  })

  test.each([
    ["set", { TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: OVERRIDE_ORIGIN }, OVERRIDE_ORIGIN],
    ["unset", { TYPESAFE_API_KEY: "test-key" }, DEFAULT_ORIGIN],
  ] as const)("#given OMO_JEV_BASE_URL is %s #when the real backend dispatches #then the request uses %s", async (_state, env, expectedOrigin) => {
    setMainSession(SESSION_ID)
    const requestSeen = Promise.withResolvers<string>()
    const fetch: NonNullable<DecisionBackendDeps["fetch"]> = async (url) => {
      requestSeen.resolve(String(url))
      return validRealResponse()
    }
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig({ backend: "real" }),
      vocab: VOCABULARY,
      env,
      fetch,
      logger: () => {},
    })

    const currentTurn = turn("Route through the real backend")
    routing.dispatch(currentTurn.input, currentTurn.output)
    const requestURL = await requestSeen.promise

    expect(new URL(requestURL).origin).toBe(expectedOrigin)
  })

  test("#given a max_prompt_chars prompt #when measuring the synchronous seam #then p99 stays below one millisecond", () => {
    setMainSession(SESSION_ID)
    const routing = createTestJevIntentRouting({
      jevConfig: enabledConfig({ maxInflight: 64 }),
      vocab: VOCABULARY,
      dispatcher: () => new Promise<IntentRoutingDecisionResult>(() => {}),
      logger: () => {},
    })
    const currentTurn = turn("x".repeat(MAX_PROMPT_CHARS))
    const durations: number[] = []

    for (let sample = 0; sample < 250; sample += 1) {
      const startedAt = performance.now()
      routing.dispatch(currentTurn.input, currentTurn.output)
      durations.push(performance.now() - startedAt)
    }

    const sorted = durations.toSorted((left, right) => left - right)
    const p99Index = Math.ceil(sorted.length * 0.99) - 1
    const p99 = sorted[p99Index] ?? Number.POSITIVE_INFINITY
    expect(p99).toBeLessThan(1)
  })
})

test("#given a known main session and a different session #when checking the named predicate #then the non-main session is rejected", () => {
  setMainSession(SESSION_ID)

  expect(isJevIntentRoutingSessionEligible("other-session")).toBe(false)
})
