import { afterEach, describe, expect, test } from "bun:test"
import type { DecisionBackendDeps, IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import { JevConfigSchema } from "../config/schema/jev"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import { createJevIntentRouting, type JevIntentRoutingDispatcher } from "../features/jev"
import {
  INTENT_ROUTING_BUDGET_SAMPLE_COUNT,
  INTENT_ROUTING_CPU_P99_BOUND_US,
  measureIntentRoutingSynchronousP99,
} from "../features/jev/intent-routing-budget-test-support"
import { createIntentRoutingTestSink } from "../features/jev/intent-routing-test-sink"
import { createChatMessageHandler } from "./chat-message"
import {
  INTENT_ROUTING_VOCABULARY,
  runDeferredMacrotask,
} from "./intent-routing-inert.test-support"
import type { PluginContext } from "./types"

const HANDLER_BOUND_MS = 50

function pluginContext(): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: process.cwd(),
    client: { tui: { showToast: async () => undefined } },
  })
}

function pluginConfig(): OhMyOpenCodeConfig {
  return unsafeTestValue<OhMyOpenCodeConfig>({})
}

function enabledConfig(options: {
  readonly backend?: "mock" | "real"
  readonly maxInflight?: number
  readonly maxPromptChars?: number
}) {
  return JevConfigSchema.parse({
    enabled: true,
    backend: options.backend ?? "mock",
    model: "jev-test",
    wires: {
      intent_routing: {
        enabled: true,
        timeout_ms: 100,
        turn_seal_timeout_ms: 120_000,
        max_inflight: options.maxInflight ?? 8,
        max_prompt_chars: options.maxPromptChars ?? 8_000,
      },
    },
  })
}

function handlerFor(intentRouting: ReturnType<typeof createJevIntentRouting>) {
  return createChatMessageHandler({
    ctx: pluginContext(),
    pluginConfig: pluginConfig(),
    firstMessageVariantGate: {
      shouldOverride: () => false,
      markApplied: () => undefined,
    },
    hooks: {},
    intentRouting,
  })
}

function timedOutResult(onStateBuild?: () => void): IntentRoutingDecisionResult {
  onStateBuild?.()
  return {
    predictionStatus: "failed",
    truncatedInput: false,
    answers: null,
    invalidAnswerCount: 0,
    unavailableReason: "timeout",
    resolvedModel: null,
    latencyMs: 100,
    threshold: 0.8,
    questionVersion: 1,
  }
}

afterEach(() => _resetForTesting())

describe("chat.message Jev intent-routing budget clauses", () => {
  test("#given a never-resolving dispatcher #when chat.message resolves #then the request remains in flight without being awaited", async () => {
    const sessionID = "session-never-dispatcher"
    setMainSession(sessionID)
    let dispatcherStarted = false
    const dispatcher: JevIntentRoutingDispatcher = () => {
      dispatcherStarted = true
      return new Promise<IntentRoutingDecisionResult>(() => undefined)
    }
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig({}),
      vocab: INTENT_ROUTING_VOCABULARY,
      dispatcher,
      logger: () => undefined,
      sink: createIntentRoutingTestSink(),
    })

    const startedAt = performance.now()
    await handlerFor(routing)(
      { sessionID, agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: "do not await the dispatcher" }] },
    )
    const handlerMs = performance.now() - startedAt
    await runDeferredMacrotask()

    expect(handlerMs).toBeLessThan(HANDLER_BOUND_MS)
    expect(dispatcherStarted).toBe(true)
    expect(routing.getStats()).toEqual({ inFlight: 1, dispatchesDropped: 0 })
    console.log(`TASK15_NO_AWAIT dispatcherHandlerMs=${handlerMs.toFixed(3)} dispatcherInFlight=1`)
    await routing.dispose()
  })

  test("#given a never-resolving real fetch #when chat.message resolves #then the HTTP request remains in flight without being awaited", async () => {
    const sessionID = "session-never-fetch"
    setMainSession(sessionID)
    let fetchStarted = false
    const backendFetch: NonNullable<DecisionBackendDeps["fetch"]> = () => {
      fetchStarted = true
      return new Promise<Response>(() => undefined)
    }
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig({ backend: "real" }),
      vocab: INTENT_ROUTING_VOCABULARY,
      env: { TYPESAFE_API_KEY: "task-15-test-key", OMO_JEV_BASE_URL: "https://hanging.invalid" },
      backendFetch,
      logger: () => undefined,
      sink: createIntentRoutingTestSink(),
    })

    const startedAt = performance.now()
    await handlerFor(routing)(
      { sessionID, agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: "do not await fetch" }] },
    )
    const handlerMs = performance.now() - startedAt
    await runDeferredMacrotask()

    expect(handlerMs).toBeLessThan(HANDLER_BOUND_MS)
    expect(fetchStarted).toBe(true)
    expect(routing.getStats()).toEqual({ inFlight: 1, dispatchesDropped: 0 })
    console.log(`TASK15_NO_AWAIT fetchHandlerMs=${handlerMs.toFixed(3)} fetchInFlight=1`)
    await routing.dispose()
  })

  test("#given a max_prompt_chars prompt #when only the synchronous seam is sampled 200 times #then CPU-time p99 stays below one millisecond and wall p99 is reported", () => {
    const sessionID = "session-p99"
    setMainSession(sessionID)
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig({ maxInflight: 64, maxPromptChars: 8_000 }),
      vocab: INTENT_ROUTING_VOCABULARY,
      dispatcher: async () => timedOutResult(),
      logger: () => undefined,
      sink: createIntentRoutingTestSink(),
    })
    const output = { parts: [{ type: "text", text: "x".repeat(8_000) }] }

    const metrics = measureIntentRoutingSynchronousP99(() => {
      routing.observe({ sessionID }, output)
    })

    console.log(`TASK15_P99 samples=${metrics.sampleCount} cpuP99Us=${metrics.cpuP99Us.toFixed(0)} cpuBoundUs=${INTENT_ROUTING_CPU_P99_BOUND_US} wallP99Ms=${metrics.wallP99Ms.toFixed(6)}`)
    expect(metrics.sampleCount).toBe(INTENT_ROUTING_BUDGET_SAMPLE_COUNT)
    expect(metrics.cpuP99Us).toBeLessThan(INTENT_ROUTING_CPU_P99_BOUND_US)
  })

  test("#given deferred state building #when the caller continues in a microtask #then the continuation precedes the macrotask", async () => {
    const sessionID = "session-macrotask-order"
    setMainSession(sessionID)
    const order: string[] = []
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig({}),
      vocab: INTENT_ROUTING_VOCABULARY,
      dispatcher: async () => timedOutResult(() => order.push("state-building")),
      logger: () => undefined,
      sink: createIntentRoutingTestSink(),
    })

    routing.observe(
      { sessionID },
      { parts: [{ type: "text", text: "defer state building" }] },
    )
    await Promise.resolve()
    order.push("caller-continuation")
    await runDeferredMacrotask()

    expect(order).toEqual(["caller-continuation", "state-building"])
    await routing.dispose()
  })
})
