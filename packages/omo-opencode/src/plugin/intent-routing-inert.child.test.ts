import type { DecisionBackendDeps } from "@oh-my-opencode/jev-core"
import { existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import { JevConfigSchema } from "../config/schema/jev"
import { setMainSession } from "../features/claude-code-session-state"
import { createJevIntentRouting, type JevIntentRouting } from "../features/jev"
import {
  createIntentRoutingSink,
  readIntentRoutingSink,
} from "../features/jev/intent-routing-sink"
import { createChatMessageHandler } from "./chat-message"
import {
  INTENT_ROUTING_VOCABULARY,
} from "./intent-routing-inert.test-support"
import type { PluginContext } from "./types"

type ChildMode = "stress" | "exit"

class IntentRoutingChildConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntentRoutingChildConfigurationError"
  }
}

function childMode(): ChildMode | null {
  switch (process.env.TASK15_CHILD_MODE) {
    case "stress":
      return "stress"
    case "exit":
      return "exit"
    default:
      return null
  }
}

function pluginContext(): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: process.cwd(),
    client: {
      tui: { showToast: async () => undefined },
      session: { messages: async () => ({ data: [] }) },
    },
  })
}

function pluginConfig(): OhMyOpenCodeConfig {
  return unsafeTestValue<OhMyOpenCodeConfig>({})
}

function config(options: {
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly maxInflight: number
}) {
  return JevConfigSchema.parse({
    enabled: options.enabled,
    backend: "real",
    model: "jev-test-pinned",
    wires: {
      intent_routing: {
        enabled: options.enabled,
        timeout_ms: options.timeoutMs,
        turn_seal_timeout_ms: 120_000,
        max_prompt_chars: 8_000,
        max_inflight: options.maxInflight,
      },
    },
  })
}

function handler(routing: JevIntentRouting) {
  return createChatMessageHandler({
    ctx: pluginContext(),
    pluginConfig: pluginConfig(),
    firstMessageVariantGate: {
      shouldOverride: () => false,
      markApplied: () => undefined,
    },
    hooks: {},
    intentRouting: routing,
  })
}

function controlledHangingFetch(): {
  readonly fetch: NonNullable<DecisionBackendDeps["fetch"]>
  readonly starts: () => number
  readonly release: () => void
} {
  let starts = 0
  const rejectors: Array<(reason?: unknown) => void> = []
  return {
    fetch: () => {
      starts += 1
      return new Promise<Response>((_resolve, reject) => { rejectors.push(reject) })
    },
    starts: () => starts,
    release: () => {
      for (const reject of rejectors.splice(0)) {
        reject(new TypeError("released hanging task-15 backend"))
      }
    },
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new IntentRoutingChildConfigurationError("Timed out waiting for task-15 child state")
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

async function runStress(home: string): Promise<void> {
  const hanging = controlledHangingFetch()
  const sink = createIntentRoutingSink()
  const enabled = createJevIntentRouting({
    jevConfig: config({ enabled: true, timeoutMs: 30_000, maxInflight: 4 }),
    vocab: INTENT_ROUTING_VOCABULARY,
    env: { TYPESAFE_API_KEY: "task-15-test-key", OMO_JEV_BASE_URL: "https://hanging.invalid" },
    backendFetch: hanging.fetch,
    logger: () => undefined,
    sink,
  })
  const disabled = createJevIntentRouting({
    jevConfig: config({ enabled: false, timeoutMs: 30_000, maxInflight: 4 }),
    vocab: INTENT_ROUTING_VOCABULARY,
  })
  const enabledHandler = handler(enabled)
  const disabledHandler = handler(disabled)
  const sessionID = "task-15-stress"
  setMainSession(sessionID)

  Bun.gc(true)
  const heapBefore = process.memoryUsage().heapUsed
  const disabledStartedAt = performance.now()
  for (let index = 0; index < 50; index += 1) {
    await disabledHandler(
      { sessionID: "task-15-disabled", agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: `turn-${index}:${"x".repeat(7_980)}` }] },
    )
  }
  const disabledWallMs = performance.now() - disabledStartedAt
  const enabledStartedAt = performance.now()
  for (let index = 0; index < 50; index += 1) {
    await enabledHandler(
      { sessionID, agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: `turn-${index}:${"x".repeat(7_980)}` }] },
    )
  }
  const enabledWallMs = performance.now() - enabledStartedAt

  await waitUntil(() => {
    const stats = enabled.getStats()
    return stats.inFlight + stats.dispatchesDropped === 50
  }, 2_000)
  const peak = enabled.getStats()
  const fetchStarts = hanging.starts()
  hanging.release()
  await waitUntil(() => enabled.getStats().inFlight === 0, 2_000)
  enabled.onSessionIdle(sessionID)
  Bun.gc(true)
  const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore)
  await enabled.dispose()
  await disabled.dispose()
  const sinkRead = readIntentRoutingSink(join(home, ".omo", "jev"))
  const observationCount = sinkRead.entries.filter((entry) => entry.kind === "observation").length

  console.log(`TASK15_STRESS_JSON=${JSON.stringify({
    turns: 50,
    disabledWallMs,
    enabledWallMs,
    addedWallMs: Math.max(0, enabledWallMs - disabledWallMs),
    maxInFlight: peak.inFlight,
    dispatchesDropped: peak.dispatchesDropped,
    fetchStarts,
    heapGrowthBytes,
    observationCount,
    sinkPath: sink.filePath,
    sinkExists: existsSync(sink.filePath),
    home,
  })}`)
}

async function runExit(home: string): Promise<void> {
  const receiptPath = process.env.TASK15_CHILD_RECEIPT
  if (!receiptPath) {
    throw new IntentRoutingChildConfigurationError("TASK15_CHILD_RECEIPT is required")
  }
  const sink = createIntentRoutingSink()
  const routing = createJevIntentRouting({
    jevConfig: config({ enabled: true, timeoutMs: 30_000, maxInflight: 4 }),
    vocab: INTENT_ROUTING_VOCABULARY,
    env: { TYPESAFE_API_KEY: "task-15-test-key", OMO_JEV_BASE_URL: "https://hanging.invalid" },
    backendFetch: () => new Promise<Response>(() => {
      setTimeout(() => undefined, 30_000)
    }),
    logger: () => undefined,
    sink,
  })
  setMainSession("task-15-exit")
  await handler(routing)(
    { sessionID: "task-15-exit", agent: "sisyphus" },
    { message: {}, parts: [{ type: "text", text: "exit without retaining the event loop" }] },
  )
  writeFileSync(receiptPath, JSON.stringify({
    wireEnabled: routing.enabled,
    home,
    sinkPath: sink.filePath,
  }))
}

const mode = childMode()
if (mode !== null) {
  const home = process.env.HOME
  if (!home || homedir() !== home) {
    throw new IntentRoutingChildConfigurationError("Child HOME was not isolated")
  }
  switch (mode) {
    case "stress":
      await runStress(home)
      break
    case "exit":
      await runExit(home)
      break
  }
}
