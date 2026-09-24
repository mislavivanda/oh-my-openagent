import { describe, expect, mock, test } from "bun:test"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import {
  isIntentRoutingCaptureSessionEligible,
  isJevIntentRoutingSessionEligible,
} from "../features/jev"
import { createPluginInterface } from "../plugin-interface"
import { createChatMessageHandler } from "./chat-message"
import type { PluginContext } from "./types"

type IntentRoutingOverride = {
  readonly observe: () => { readonly predictionStatus: "pending"; readonly notDispatchedReason: null }
  readonly capture: (
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string },
    output: { readonly args: Readonly<Record<string, unknown>> },
  ) => void
  readonly onSessionIdle: (sessionID: string) => void
  readonly onSessionDeleted: (sessionID: string) => void
}

function injectIntentRouting<T extends object>(args: T, intentRouting: object): T {
  Reflect.set(args, "intentRouting", intentRouting)
  return args
}

function pluginContext(): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: "/tmp/jev-intent-routing-wiring",
    client: { tui: { showToast: async () => undefined } },
  })
}

function pluginConfig(): OhMyOpenCodeConfig {
  return unsafeTestValue<OhMyOpenCodeConfig>({})
}

describe("Jev intent-routing plugin handler wiring", () => {
  test("#given one override #when chat, tool, and lifecycle handlers run #then the same object receives all calls without input mutation", async () => {
    const receivers: object[] = []
    const calls: string[] = []
    const capturedArgs: Readonly<Record<string, unknown>>[] = []
    const intentRouting: IntentRoutingOverride = {
      observe() {
        receivers.push(this)
        calls.push("chat.message")
        return { predictionStatus: "pending", notDispatchedReason: null }
      },
      capture(_input, output) {
        receivers.push(this)
        calls.push("tool.execute.before")
        capturedArgs.push(structuredClone(output.args))
      },
      onSessionIdle(sessionID) {
        receivers.push(this)
        calls.push(`event:${sessionID}:idle`)
      },
      onSessionDeleted(sessionID) {
        receivers.push(this)
        calls.push(`event:${sessionID}:deleted`)
      },
    }
    const args = injectIntentRouting(
      unsafeTestValue<Parameters<typeof createPluginInterface>[0]>({
        ctx: pluginContext(),
        pluginConfig: pluginConfig(),
        firstMessageVariantGate: {
          shouldOverride: () => false,
          markApplied: () => undefined,
          markSessionCreated: () => undefined,
          clear: () => undefined,
        },
        managers: {
          configHandler: async () => undefined,
          backgroundManager: {},
          tmuxSessionManager: {},
          skillMcpManager: { disconnectSession: async () => undefined },
        },
        hooks: { disposeHooks: () => undefined },
        tools: {},
      }),
      intentRouting,
    )
    const plugin = createPluginInterface(args)
    const chatOutput = { message: {}, parts: [{ type: "text", text: "route this" }] }
    const toolOutput = { args: { category: "quick" } }

    await plugin["chat.message"]?.(
      unsafeTestValue({ sessionID: "session-main", agent: "sisyphus" }),
      unsafeTestValue(chatOutput),
    )
    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID: "session-main", callID: "call-1" },
      toolOutput,
    )
    await plugin.event?.(unsafeTestValue({
      event: { type: "session.idle", properties: { sessionID: "session-main" } },
    }))
    await plugin.event?.(unsafeTestValue({
      event: { type: "session.deleted", properties: { info: { id: "session-main" } } },
    }))

    expect(calls).toEqual([
      "chat.message",
      "tool.execute.before",
      "event:session-main:idle",
      "event:session-main:deleted",
    ])
    expect(receivers).toEqual([
      intentRouting,
      intentRouting,
      intentRouting,
      intentRouting,
    ])
    expect(chatOutput.parts).toEqual([{ type: "text", text: "route this" }])
    expect(capturedArgs).toEqual([{ category: "quick" }])
    expect(toolOutput.args).toEqual({ category: "quick", subagent_type: "sisyphus-junior" })
  })

  test("#given a dispatcher that takes three seconds #when chat.message runs #then the handler starts it without awaiting it", async () => {
    const dispatcher = mock(() => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      timer.unref()
    }))
    const intentRouting = {
      observe: () => {
        void dispatcher()
        return { predictionStatus: "pending" as const, notDispatchedReason: null }
      },
    }
    const args = injectIntentRouting({
      ctx: pluginContext(),
      pluginConfig: pluginConfig(),
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => undefined,
      },
      hooks: unsafeTestValue<Parameters<typeof createChatMessageHandler>[0]["hooks"]>({}),
    }, intentRouting)
    const handler = createChatMessageHandler(args)

    const startedAt = performance.now()
    await handler(
      unsafeTestValue({ sessionID: "session-main", agent: "sisyphus" }),
      { message: {}, parts: [{ type: "text", text: "do not wait" }] },
    )
    const elapsedMs = performance.now() - startedAt
    console.log(`chat.message non-awaited proof: ${elapsedMs.toFixed(3)}ms`)

    expect(dispatcher).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(50)
  })

  test("#given identical session facts #when dispatch and capture check eligibility #then both call sites share one predicate", () => {
    const cases = [
      { input: { sessionID: "main", mainSessionID: "main", isSubagentSession: false }, expected: true },
      { input: { sessionID: "main", mainSessionID: undefined, isSubagentSession: false }, expected: false },
      { input: { sessionID: "child", mainSessionID: "main", isSubagentSession: false }, expected: false },
      { input: { sessionID: "main", mainSessionID: "main", isSubagentSession: true }, expected: false },
    ] as const

    expect(isIntentRoutingCaptureSessionEligible).toBe(isJevIntentRoutingSessionEligible)
    for (const { input, expected } of cases) {
      expect(Reflect.apply(isJevIntentRoutingSessionEligible, undefined, [input])).toBe(expected)
      expect(Reflect.apply(isIntentRoutingCaptureSessionEligible, undefined, [input])).toBe(expected)
    }
  })
})
