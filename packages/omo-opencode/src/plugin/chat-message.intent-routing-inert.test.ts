import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import { JevConfigSchema, type JevConfig } from "../config/schema/jev"
import {
  _resetForTesting,
  setMainSession,
} from "../features/claude-code-session-state"
import {
  createJevIntentRouting,
  type JevIntentRoutingDispatcher,
} from "../features/jev"
import { createChatMessageHandler } from "./chat-message"
import type { ChatMessageHooks } from "./chat-message/types"

const RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "unavailable",
  unavailableReason: "timeout",
  resolvedModel: "jev-inert-test",
  latencyMs: 100,
  answers: null,
  invalidAnswerCount: 0,
  truncatedInput: false,
  threshold: 0.8,
  questionVersion: 1,
}

const HOOK_ORDER = [
  "modelFallback",
  "stopContinuationGuard",
  "backgroundNotificationHook",
  "runtimeFallback",
  "keywordDetector",
  "thinkMode",
  "claudeCodeHooks",
  "autoSlashCommand",
  "noSisyphusGpt",
  "noHephaestusNonGpt",
  "hephaestusAgentsMdInjector",
  "startWork",
] as const

type FailureMode = "sync-throw" | "async-reject" | "timeout"

function config(enabled: boolean): JevConfig {
  return JevConfigSchema.parse({
    enabled,
    backend: "mock",
    wires: { intent_routing: { enabled } },
  })
}

function dispatcher(mode: FailureMode, started: () => void): JevIntentRoutingDispatcher {
  return () => {
    started()
    switch (mode) {
      case "sync-throw": throw new Error("synchronous backend failure")
      case "async-reject": return Promise.reject(new Error("asynchronous backend failure"))
      case "timeout": return Promise.resolve(RESULT)
    }
  }
}

function orderedHooks(order: string[]): ChatMessageHooks {
  const hook = (name: string) => ({
    "chat.message": async () => { order.push(name) },
  })
  return {
    modelFallback: hook("modelFallback"),
    stopContinuationGuard: {
      "chat.message": async () => { order.push("stopContinuationGuard") },
      isStopped: () => false,
      clear: () => {},
    },
    backgroundNotificationHook: hook("backgroundNotificationHook"),
    runtimeFallback: hook("runtimeFallback"),
    keywordDetector: hook("keywordDetector"),
    thinkMode: hook("thinkMode"),
    claudeCodeHooks: hook("claudeCodeHooks"),
    autoSlashCommand: hook("autoSlashCommand"),
    noSisyphusGpt: hook("noSisyphusGpt"),
    noHephaestusNonGpt: hook("noHephaestusNonGpt"),
    hephaestusAgentsMdInjector: hook("hephaestusAgentsMdInjector"),
    startWork: hook("startWork"),
  }
}

async function runHandler(enabled: boolean, mode: FailureMode) {
  const order: string[] = []
  let signalStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  const routing = createJevIntentRouting({
    jevConfig: config(enabled),
    dispatcher: dispatcher(mode, () => signalStarted?.()),
    logger: () => {},
  })
  const output = {
    message: {},
    parts: [{ type: "text", text: "route without mutating this" }],
  }
  const originalParts = structuredClone(output.parts)
  const originalBytes = JSON.stringify(originalParts)
  const handler = createChatMessageHandler({
    ctx: { directory: "/tmp/jev-inert", client: { tui: { showToast: async () => ({}) } } },
    pluginConfig: {},
    firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
    hooks: orderedHooks(order),
    intentRouting: routing,
  })
  await handler({ sessionID: "main", agent: "sisyphus" }, output)
  if (enabled) await started
  return { bytes: JSON.stringify(output.parts), order, originalBytes, originalParts, output, routing }
}

beforeEach(() => {
  _resetForTesting()
  setMainSession("main")
})
afterEach(() => _resetForTesting())

describe("chat.message Jev intent-routing inertness", () => {
  for (const mode of ["sync-throw", "async-reject", "timeout"] as const) {
    test(`#given a ${mode} backend #when the wire is toggled #then output bytes and hook order stay identical`, async () => {
      const disabled = await runHandler(false, mode)
      const enabled = await runHandler(true, mode)

      expect(enabled.output.parts).toEqual(disabled.output.parts)
      expect(enabled.bytes).toBe(disabled.bytes)
      expect(enabled.output.parts).toEqual(enabled.originalParts)
      expect(enabled.bytes).toBe(enabled.originalBytes)
      expect(enabled.order).toEqual(disabled.order)
      expect(enabled.order).toEqual(HOOK_ORDER)
    })
  }

  test("#given never-resolving dispatcher I/O #when chat.message runs #then it resolves while work is in flight", async () => {
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const routing = createJevIntentRouting({
      jevConfig: config(true),
      dispatcher: () => {
        signalStarted?.()
        return new Promise<IntentRoutingDecisionResult>(() => {})
      },
      logger: () => {},
    })
    const handler = createChatMessageHandler({
      ctx: { directory: "/tmp/jev-inert", client: { tui: { showToast: async () => ({}) } } },
      pluginConfig: {},
      firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
      hooks: {},
      intentRouting: routing,
    })

    const operation = handler(
      { sessionID: "main", agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: "never await this request" }] },
    )
    await started
    await expect(Promise.race([
      operation.then(() => "resolved"),
      Bun.sleep(100).then(() => "deadline"),
    ])).resolves.toBe("resolved")
    expect(routing.inFlight).toBe(1)
  })

  test("#given a max-sized prompt #when measuring only observe #then p99 is below one millisecond", () => {
    const routing = createJevIntentRouting({
      jevConfig: config(true),
      dispatcher: async () => RESULT,
      logger: () => {},
    })
    const prompt = "x".repeat(config(true).wires.intent_routing.max_prompt_chars)
    const durations: number[] = []

    for (let sample = 0; sample < 200; sample += 1) {
      const startedAt = performance.now()
      routing.observe({ sessionID: "main" }, { parts: [{ type: "text", text: prompt }] })
      durations.push(performance.now() - startedAt)
    }
    const sorted = durations.toSorted((left, right) => left - right)
    const p99Ms = sorted[Math.floor(sorted.length * 0.99)] ?? Number.POSITIVE_INFINITY
    console.log(`TASK15_SYNC_P99_US=${(p99Ms * 1000).toFixed(2)}`)

    expect(p99Ms).toBeLessThan(1)
  })

  test("#given a caller continuation #when observe schedules work #then the continuation precedes state building", async () => {
    const order: string[] = []
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const routing = createJevIntentRouting({
      jevConfig: config(true),
      dispatcher: async () => {
        order.push("state-building")
        signalStarted?.()
        return RESULT
      },
      logger: () => {},
    })

    routing.observe({ sessionID: "main" }, { parts: [{ type: "text", text: "order me" }] })
    Promise.resolve().then(() => order.push("caller-continuation"))
    await started

    expect(order).toEqual(["caller-continuation", "state-building"])
  })
})
