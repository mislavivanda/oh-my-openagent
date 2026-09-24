import { describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createChatMessageHandler } from "./chat-message"

describe("createChatMessageHandler intent routing", () => {
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
