import { describe, expect, mock, test } from "bun:test"
import type { IntentRoutingEntry } from "@oh-my-opencode/jev-core"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { JevConfigSchema } from "../config/schema/jev"
import {
  JEV_INTENT_ROUTING_VOCABULARY,
  type IntentRoutingSink,
} from "../features/jev"
import { createJevIntentRoutingRuntime } from "../features/jev/intent-routing-runtime"
import { createChatMessageHandler } from "./chat-message"

describe("createChatMessageHandler intent routing", () => {
  test("#given a synthetic message #when chat.message runs #then it counts once without prediction dispatch, a turn record, or output mutation", async () => {
    // given
    const entries: IntentRoutingEntry[] = []
    const runtime = createJevIntentRoutingRuntime({
      jevConfig: JevConfigSchema.parse({
        enabled: true,
        backend: "mock",
        wires: {
          intent_routing: {
            enabled: true,
            timeout_ms: 100,
            turn_seal_timeout_ms: 1_000,
          },
        },
      }),
      vocab: JEV_INTENT_ROUTING_VOCABULARY,
      sink: {
        processId: "synthetic-chat-test",
        filePath: "/tmp/synthetic-chat-test.jsonl",
        counterEpoch: 0,
        write(entry) {
          entries.push(entry)
          return true
        },
        dispose() {},
      } satisfies IntentRoutingSink,
    })
    const predictionDispatch = mock(async () => {
      throw new Error("synthetic messages must not dispatch a prediction")
    })
    const handler = createChatMessageHandler(unsafeTestValue({
      ctx: { client: { tui: { showToast: async () => {} } } },
      pluginConfig: {},
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {},
      intentRouting: {
        dispatch(
          input: { readonly sessionID: string },
          output: { readonly parts: readonly { readonly type?: string; readonly text?: string; readonly synthetic?: boolean }[] },
        ): void {
          runtime.handleMessage({
            sessionID: input.sessionID,
            parts: output.parts,
            truncatedInput: false,
            dispatch: predictionDispatch,
          })
        },
      },
    }))
    const output = {
      message: {},
      parts: [{ type: "text", text: "internal", synthetic: true }],
    }
    const originalParts = structuredClone(output.parts)

    // when
    await handler(
      unsafeTestValue({ sessionID: "ses-synthetic", agent: "sisyphus" }),
      unsafeTestValue(output),
    )
    await runtime.dispose()

    // then
    expect(runtime.turnsSynthetic).toBe(1)
    expect(predictionDispatch).not.toHaveBeenCalled()
    expect(entries.filter((entry) => entry.kind === "observation")).toEqual([])
    expect(output.parts).toEqual(originalParts)
  })

  test("#given a dispatcher that sleeps for 3000ms #when chat.message runs #then the handler resolves in under 50ms", async () => {
    // given
    const dispatcher = mock(() => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      timer.unref()
    }))
    const intentRouting = {
      dispatch(): void {
        void dispatcher()
      },
    }
    const handler = createChatMessageHandler(unsafeTestValue({
      ctx: { client: { tui: { showToast: async () => {} } } },
      pluginConfig: {},
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {},
      intentRouting,
    }))

    // when
    const startedAt = performance.now()
    await handler(
      unsafeTestValue({ sessionID: "ses-not-awaited", agent: "sisyphus" }),
      unsafeTestValue({ message: {}, parts: [{ type: "text", text: "route this" }] }),
    )
    const elapsedMs = performance.now() - startedAt

    // then
    if (process.env.JEV_WIRING_EVIDENCE === "1") {
      console.log(`dispatcher_sleep_ms=3000 handler_elapsed_ms=${elapsedMs.toFixed(3)} limit_ms=50`)
    }
    expect(dispatcher).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(50)
  })
})
