import { afterEach, describe, expect, test } from "bun:test"
import type {
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../config/schema/jev"
import {
  createJevIntentRouting,
  JEV_INTENT_ROUTING_VOCABULARY,
  type IntentRoutingSink,
  type JevIntentRoutingDispatcher,
} from "../features/jev"
import {
  _resetForTesting,
  setMainSession,
} from "../features/claude-code-session-state/state"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createChatMessageHandler } from "./chat-message"

const SESSION_ID = "ses-chat-inert"
const FAILURE_MODES = ["sync_throw", "async_reject", "timeout"] as const
type FailureMode = typeof FAILURE_MODES[number]

function createConfig(wireEnabled: boolean) {
  return JevConfigSchema.parse({
    enabled: true,
    backend: "mock",
    model: "jev-inert-test",
    wires: {
      intent_routing: {
        enabled: wireEnabled,
        timeout_ms: 100,
        turn_seal_timeout_ms: 1_000,
      },
    },
  })
}

function createDispatcher(mode: FailureMode): JevIntentRoutingDispatcher {
  switch (mode) {
    case "sync_throw":
      return () => {
        throw new TypeError("synchronous backend failure")
      }
    case "async_reject":
      return async () => {
        throw new TypeError("asynchronous backend failure")
      }
    case "timeout":
      return () => new Promise<IntentRoutingDecisionResult>(() => {})
  }
}

function createRecordingSink(entries: IntentRoutingEntry[]): IntentRoutingSink {
  return {
    processId: "chat-inert-test",
    filePath: "/tmp/chat-inert-test.jsonl",
    counterEpoch: 0,
    write(entry) {
      entries.push(entry)
      return true
    },
    dispose() {},
  }
}

async function settleFailure(mode: FailureMode): Promise<void> {
  const delayMs = mode === "timeout" ? 120 : 0
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  await Promise.resolve()
}

async function runChatMessage(mode: FailureMode, wireEnabled: boolean) {
  const hookOrder: string[] = []
  const sinkEntries: IntentRoutingEntry[] = []
  const jevConfig = createConfig(wireEnabled)
  const routing = createJevIntentRouting({
    jevConfig,
    vocab: JEV_INTENT_ROUTING_VOCABULARY,
    dispatcher: createDispatcher(mode),
    logger: () => {},
    sink: createRecordingSink(sinkEntries),
  })
  const hook = (name: string) => ({
    "chat.message": async () => {
      hookOrder.push(name)
    },
  })
  const handler = createChatMessageHandler(unsafeTestValue({
    ctx: { directory: process.cwd(), client: { tui: { showToast: async () => {} } } },
    pluginConfig: { jev: jevConfig },
    firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
    hooks: {
      modelFallback: hook("model-fallback"),
      backgroundNotificationHook: hook("background-notification"),
      keywordDetector: hook("keyword-detector"),
      thinkMode: hook("think-mode"),
    },
    intentRouting: routing,
  }))
  const output = {
    message: { role: "user", metadata: { stable: true } },
    parts: [
      { type: "text", text: "route without changing me", metadata: { index: 0 } },
      { type: "file", text: "attachment", mime: "text/plain" },
    ],
  }

  await handler(
    { sessionID: SESSION_ID, agent: "sisyphus" },
    unsafeTestValue(output),
  )
  await settleFailure(mode)
  routing.handleSessionIdle(SESSION_ID)
  await routing.dispose()

  return {
    parts: output.parts,
    serialized: JSON.stringify(output.parts),
    hookOrder,
    sinkEntries,
  }
}

afterEach(() => {
  _resetForTesting()
})

describe("chat.message intent-routing inertness", () => {
  test.each(FAILURE_MODES)("#given a %s backend #when the wire is enabled versus disabled #then parts stay byte-identical and other hooks keep their set and order", async (mode) => {
    setMainSession(SESSION_ID)
    const disabled = await runChatMessage(mode, false)
    const enabled = await runChatMessage(mode, true)
    const expectedOrder = [
      "model-fallback",
      "background-notification",
      "keyword-detector",
      "think-mode",
    ]

    expect(enabled.serialized).toBe(disabled.serialized)
    expect(Buffer.compare(Buffer.from(enabled.serialized), Buffer.from(disabled.serialized))).toBe(0)
    expect(enabled.parts).toEqual(disabled.parts)
    expect(enabled.hookOrder).toEqual(disabled.hookOrder)
    expect(enabled.hookOrder).toEqual(expectedOrder)
    expect(new Set(enabled.hookOrder)).toEqual(new Set(expectedOrder))

    const expectedPredictionStatus = mode === "timeout" ? "timeout" : "failed"
    expect(enabled.sinkEntries).toContainEqual(expect.objectContaining({
      kind: "observation",
      predictionStatus: expectedPredictionStatus,
    }))
    expect(disabled.sinkEntries).toEqual([])
  })
})
