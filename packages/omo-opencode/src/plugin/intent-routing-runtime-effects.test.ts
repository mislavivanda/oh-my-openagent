// allow: SIZE_OK - runtime-effects acceptance keeps the 50-turn and child-process proofs in one executable suite.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DecisionBackendDeps } from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../config/schema/jev"
import {
  createIntentRoutingSink,
  createJevIntentRouting,
  JEV_INTENT_ROUTING_VOCABULARY,
  type JevIntentRouting,
} from "../features/jev"
import {
  _resetForTesting,
  setMainSession,
} from "../features/claude-code-session-state/state"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createChatMessageHandler } from "./chat-message"

const SESSION_ID = "ses-intent-routing-stress"
const TURN_COUNT = 50
const MAX_INFLIGHT = 2
const HANDLER_BOUND_MS = 50
const ADDED_TOTAL_BOUND_MS = 50
const HEAP_GROWTH_BOUND_BYTES = 16 * 1024 * 1024
const CHILD_EXIT_BOUND_MS = 1_500

function createConfig(wireEnabled: boolean) {
  return JevConfigSchema.parse({
    enabled: true,
    backend: "real",
    model: "jev-runtime-effects-test",
    wires: {
      intent_routing: {
        enabled: wireEnabled,
        timeout_ms: 100,
        turn_seal_timeout_ms: 1_000,
        max_prompt_chars: 8_000,
        max_inflight: MAX_INFLIGHT,
      },
    },
  })
}

function createHandler(routing: JevIntentRouting, wireEnabled: boolean) {
  const jevConfig = createConfig(wireEnabled)
  return createChatMessageHandler(unsafeTestValue({
    ctx: { directory: process.cwd(), client: { tui: { showToast: async () => {} } } },
    pluginConfig: { jev: jevConfig },
    firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
    hooks: {},
    intentRouting: routing,
  }))
}

async function runTurns(
  handler: ReturnType<typeof createChatMessageHandler>,
  prefix: string,
): Promise<readonly number[]> {
  const durations: number[] = []
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    const startedAt = performance.now()
    await handler(
      { sessionID: SESSION_ID, agent: "sisyphus" },
      unsafeTestValue({
        message: {},
        parts: [{ type: "text", text: `${prefix} turn ${turn}` }],
      }),
    )
    durations.push(performance.now() - startedAt)
  }
  return durations
}

const CHILD_PROGRAM = [
  'import { createIntentRoutingSink, createJevIntentRouting, JEV_INTENT_ROUTING_VOCABULARY } from "./packages/omo-opencode/src/features/jev/index.ts"',
  'import { setMainSession } from "./packages/omo-opencode/src/features/claude-code-session-state/state.ts"',
  'import { JevConfigSchema } from "./packages/omo-opencode/src/config/schema/jev.ts"',
  'import { createChatMessageHandler } from "./packages/omo-opencode/src/plugin/chat-message.ts"',
  'const root = process.env.JEV_CHILD_ROOT',
  'if (!root) process.exit(22)',
  'const sessionID = "ses-child-hanging-backend"',
  'setMainSession(sessionID)',
  'const config = JevConfigSchema.parse({ enabled: true, backend: "real", model: "jev-child-test", wires: { intent_routing: { enabled: true, timeout_ms: 100, turn_seal_timeout_ms: 1000, max_inflight: 2 } } })',
  'let fetchStarted = false',
  'const sink = createIntentRoutingSink({ directory: root, counterIntervalMs: 60000 })',
  'const routing = createJevIntentRouting({ jevConfig: config, vocab: JEV_INTENT_ROUTING_VOCABULARY, env: { TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: "https://jev.invalid" }, fetch: () => { fetchStarted = true; return new Promise(() => {}) }, logger: () => {}, sink })',
  'const handler = createChatMessageHandler({ ctx: { directory: process.cwd(), client: { tui: { showToast: async () => {} } } }, pluginConfig: { jev: config }, firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} }, hooks: {}, intentRouting: routing })',
  'await handler({ sessionID, agent: "sisyphus" }, { message: {}, parts: [{ type: "text", text: "hang without retaining the process" }] })',
  'for (let attempt = 0; attempt < 20 && !fetchStarted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))',
  'if (!fetchStarted) process.exit(23)',
  'console.log("child_fetch_started=1 wire_enabled=1 backend=real sink=real")',
].join("\n")

async function runCleanExitChild(root: string) {
  const startedAt = performance.now()
  const child = Bun.spawn([process.execPath, "-e", CHILD_PROGRAM], {
    cwd: process.cwd(),
    env: { ...process.env, JEV_CHILD_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, CHILD_EXIT_BOUND_MS)
  const exitCode = await child.exited
  clearTimeout(killer)
  const elapsedMs = performance.now() - startedAt
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  return { exitCode, elapsedMs, stdout, stderr, timedOut }
}

afterEach(() => {
  _resetForTesting()
})

describe("intent-routing runtime effects with a hanging backend", () => {
  test("#given the real dispatcher and sink #when 50 consecutive turns hit a hanging backend #then latency, in-flight work, drops, and heap stay bounded", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-w1-runtime-effects-"))
    setMainSession(SESSION_ID)
    let activeFetches = 0
    let maxFetches = 0
    const fetchCapReached = Promise.withResolvers<void>()
    const fetch: NonNullable<DecisionBackendDeps["fetch"]> = () => {
      activeFetches += 1
      maxFetches = Math.max(maxFetches, activeFetches)
      if (activeFetches === MAX_INFLIGHT) fetchCapReached.resolve()
      return new Promise<Response>(() => {})
    }
    const sink = createIntentRoutingSink({ directory: root, counterIntervalMs: 60_000 })
    const enabledConfig = createConfig(true)
    const routing = createJevIntentRouting({
      jevConfig: enabledConfig,
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
      env: { TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: "https://jev.invalid" },
      fetch,
      logger: () => {},
      sink,
    })
    const disabledRouting = createJevIntentRouting({
      jevConfig: createConfig(false),
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
    })

    try {
      const disabledDurations = await runTurns(createHandler(disabledRouting, false), "disabled")
      const heapBefore = process.memoryUsage().heapUsed
      const enabledDurations = await runTurns(createHandler(routing, true), "enabled")
      const fetchDeadline = Promise.withResolvers<"timeout">()
      const fetchTimer = setTimeout(() => fetchDeadline.resolve("timeout"), 100)
      const fetchOutcome = await Promise.race([
        fetchCapReached.promise.then(() => "cap-reached" as const),
        fetchDeadline.promise,
      ])
      clearTimeout(fetchTimer)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
      const heapGrowthBytes = process.memoryUsage().heapUsed - heapBefore
      const disabledTotalMs = disabledDurations.reduce((sum, duration) => sum + duration, 0)
      const enabledTotalMs = enabledDurations.reduce((sum, duration) => sum + duration, 0)
      const addedTotalMs = Math.max(0, enabledTotalMs - disabledTotalMs)
      const maxHandlerMs = Math.max(...enabledDurations)

      expect(fetchOutcome).toBe("cap-reached")
      expect(maxHandlerMs).toBeLessThan(HANDLER_BOUND_MS)
      expect(addedTotalMs).toBeLessThan(ADDED_TOTAL_BOUND_MS)
      expect(maxFetches).toBe(MAX_INFLIGHT)
      expect(activeFetches).toBe(MAX_INFLIGHT)
      expect(routing.inFlight).toBe(MAX_INFLIGHT)
      expect(routing.dispatchesDropped).toBe(TURN_COUNT - MAX_INFLIGHT)
      expect(heapGrowthBytes).toBeLessThan(HEAP_GROWTH_BOUND_BYTES)
      expect(resolve(sink.filePath).startsWith(`${resolve(root)}/`)).toBe(true)
      expect(existsSync(sink.filePath)).toBe(true)
      if (process.env.JEV_WIRING_EVIDENCE === "1") {
        console.log(`part_c_stress turns=${TURN_COUNT} max_handler_ms=${maxHandlerMs.toFixed(3)} handler_bound_ms=${HANDLER_BOUND_MS} added_total_ms=${addedTotalMs.toFixed(3)} added_total_bound_ms=${ADDED_TOTAL_BOUND_MS} max_fetch_inflight=${maxFetches} routing_inflight=${routing.inFlight} max_inflight=${MAX_INFLIGHT} dispatches_dropped=${routing.dispatchesDropped} expected_drops=${TURN_COUNT - MAX_INFLIGHT} heap_growth_bytes=${heapGrowthBytes} heap_bound_bytes=${HEAP_GROWTH_BOUND_BYTES} sink_under_temp=1`)
      }
    } finally {
      await routing.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given the plugin wire, real dispatcher, real sink, and hanging backend #when a child finishes its turn #then unrefed timers let it exit cleanly within the bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-w1-clean-exit-"))
    try {
      const result = await runCleanExitChild(root)
      expect(
        result.timedOut,
        `child clean-exit timed out after ${CHILD_EXIT_BOUND_MS}ms; stderr=${result.stderr}`,
      ).toBe(false)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.elapsedMs).toBeLessThan(CHILD_EXIT_BOUND_MS)
      expect(result.stdout).toContain("child_fetch_started=1 wire_enabled=1 backend=real sink=real")
      if (process.env.JEV_WIRING_EVIDENCE === "1") {
        console.log(`part_c_child exit_code=${result.exitCode} elapsed_ms=${result.elapsedMs.toFixed(3)} bound_ms=${CHILD_EXIT_BOUND_MS} timed_out=${result.timedOut ? 1 : 0}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 5_000)
})
