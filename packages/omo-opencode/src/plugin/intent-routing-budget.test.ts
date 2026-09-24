import { afterEach, describe, expect, test } from "bun:test"
import type {
  DecisionBackendDeps,
  IntentRoutingDecisionResult,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../config/schema/jev"
import {
  createJevIntentRouting,
  JEV_INTENT_ROUTING_VOCABULARY,
  type IntentRoutingSink,
} from "../features/jev"
import type { JevIntentRoutingRuntime } from "../features/jev/intent-routing-runtime"
import {
  _resetForTesting,
  setMainSession,
} from "../features/claude-code-session-state/state"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createChatMessageHandler } from "./chat-message"

const SESSION_ID = "ses-intent-routing-budget"
const MAX_PROMPT_CHARS = 8_000
const SINK: IntentRoutingSink = {
  processId: "intent-routing-budget",
  filePath: "/tmp/intent-routing-budget.jsonl",
  counterEpoch: 0,
  write: () => true,
  dispose() {},
}

function createConfig(backend: "mock" | "real" = "mock") {
  return JevConfigSchema.parse({
    enabled: true,
    backend,
    model: "jev-budget-test",
    wires: {
      intent_routing: {
        enabled: true,
        timeout_ms: 100,
        turn_seal_timeout_ms: 1_000,
        max_prompt_chars: MAX_PROMPT_CHARS,
        max_inflight: 8,
      },
    },
  })
}

function createRuntime(handleMessage: JevIntentRoutingRuntime["handleMessage"]): JevIntentRoutingRuntime {
  return {
    handleMessage,
    capture: () => false,
    handleSessionIdle() {},
    handleSessionDeleted() {},
    async dispose() {},
  }
}

afterEach(() => {
  _resetForTesting()
})

describe("intent-routing handler budget", () => {
  test("#given a real dispatcher and never-resolving fetch #when chat.message resolves #then the request is demonstrably in flight and was not awaited", async () => {
    setMainSession(SESSION_ID)
    const fetchStarted = Promise.withResolvers<void>()
    let fetchInFlight = 0
    const fetch: NonNullable<DecisionBackendDeps["fetch"]> = () => {
      fetchInFlight += 1
      fetchStarted.resolve()
      return new Promise<Response>(() => {})
    }
    const config = createConfig("real")
    const routing = createJevIntentRouting({
      jevConfig: config,
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
      env: { TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: "https://jev.invalid" },
      fetch,
      logger: () => {},
      sink: SINK,
    })
    const handler = createChatMessageHandler(unsafeTestValue({
      ctx: { directory: process.cwd(), client: { tui: { showToast: async () => {} } } },
      pluginConfig: { jev: config },
      firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
      hooks: {
        backgroundNotificationHook: {
          "chat.message": async () => {
            await fetchStarted.promise
          },
        },
      },
      intentRouting: routing,
    }))
    const deadline = Promise.withResolvers<"timeout">()
    const timeout = setTimeout(() => deadline.resolve("timeout"), 100)
    const startedAt = performance.now()

    const outcome = await Promise.race([
      handler(
        { sessionID: SESSION_ID, agent: "sisyphus" },
        unsafeTestValue({ message: {}, parts: [{ type: "text", text: "do not await IO" }] }),
      ).then(() => "resolved" as const),
      deadline.promise,
    ])
    const elapsedMs = performance.now() - startedAt
    clearTimeout(timeout)

    expect(outcome).toBe("resolved")
    expect(fetchInFlight).toBe(1)
    expect(routing.inFlight).toBe(1)
    expect(elapsedMs).toBeLessThan(100)
    if (process.env.JEV_WIRING_EVIDENCE === "1") {
      console.log(`part_b_no_await outcome=${outcome} fetch_in_flight=${fetchInFlight} routing_in_flight=${routing.inFlight} handler_elapsed_ms=${elapsedMs.toFixed(3)} bound_ms=100`)
    }
    await routing.dispose()
  })

  test("#given a max_prompt_chars prompt #when the seam alone is measured over 200 samples #then p99 is below one millisecond", async () => {
    setMainSession(SESSION_ID)
    const routing = createJevIntentRouting({
      jevConfig: createConfig(),
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
      dispatcher: () => new Promise<IntentRoutingDecisionResult>(() => {}),
      logger: () => {},
      runtime: createRuntime(() => {}),
    })
    const turn = {
      input: { sessionID: SESSION_ID },
      output: { parts: [{ type: "text", text: "x".repeat(MAX_PROMPT_CHARS) }] },
    }
    const durations: number[] = []

    for (let sample = 0; sample < 200; sample += 1) {
      const startedAt = performance.now()
      routing.dispatch(turn.input, turn.output)
      durations.push(performance.now() - startedAt)
    }

    const sorted = durations.toSorted((left, right) => left - right)
    const p99Index = Math.ceil(sorted.length * 0.99) - 1
    const p99Ms = sorted[p99Index] ?? Number.POSITIVE_INFINITY
    expect(durations).toHaveLength(200)
    expect(p99Ms).toBeLessThan(1)
    if (process.env.JEV_WIRING_EVIDENCE === "1") {
      console.log(`part_b_sync samples=${durations.length} prompt_chars=${MAX_PROMPT_CHARS} p99_ms=${p99Ms.toFixed(6)} bound_ms=1`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await routing.dispose()
  })

  test("#given deferred state building #when the caller takes a promise continuation #then that continuation runs before state building", async () => {
    setMainSession(SESSION_ID)
    const order: string[] = []
    const stateBuildingStarted = Promise.withResolvers<void>()
    const routing = createJevIntentRouting({
      jevConfig: createConfig(),
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
      dispatcher: () => new Promise<IntentRoutingDecisionResult>(() => {}),
      logger: () => {},
      runtime: createRuntime(() => {
        order.push("state-building")
        stateBuildingStarted.resolve()
      }),
    })

    routing.dispatch(
      { sessionID: SESSION_ID },
      { parts: [{ type: "text", text: "defer state building" }] },
    )
    await Promise.resolve()
    order.push("caller-continuation")
    await stateBuildingStarted.promise

    expect(order).toEqual(["caller-continuation", "state-building"])
    if (process.env.JEV_WIRING_EVIDENCE === "1") {
      console.log(`part_b_ordering observed=${order.join("->")} required_first=caller-continuation`)
    }
    await routing.dispose()
  })
})
