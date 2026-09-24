import { afterEach, describe, expect, test } from "bun:test"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import { createChatMessageHandler } from "./chat-message"
import {
  CHAT_HOOK_ORDER,
  createChatHookLedger,
  createInertRouting,
  INTENT_ROUTING_FAILURE_SHAPES,
  runDeferredMacrotask,
  type IntentRoutingFailureShape,
} from "./intent-routing-inert.test-support"
import type { PluginContext } from "./types"

function pluginContext(): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: process.cwd(),
    client: { tui: { showToast: async () => undefined } },
  })
}

function pluginConfig(): OhMyOpenCodeConfig {
  return unsafeTestValue<OhMyOpenCodeConfig>({})
}

type ChatScenarioResult = {
  readonly parts: readonly unknown[]
  readonly serializedParts: string
  readonly hookOrder: readonly string[]
}

async function runChatScenario(
  enabled: boolean,
  failureShape: IntentRoutingFailureShape,
): Promise<ChatScenarioResult> {
  _resetForTesting()
  const sessionID = `session-${enabled ? "enabled" : "disabled"}-${failureShape}`
  setMainSession(sessionID)
  const hookOrder: string[] = []
  const intentRouting = createInertRouting(enabled, failureShape)
  const handler = createChatMessageHandler({
    ctx: pluginContext(),
    pluginConfig: pluginConfig(),
    firstMessageVariantGate: {
      shouldOverride: () => false,
      markApplied: () => undefined,
    },
    hooks: createChatHookLedger(hookOrder),
    intentRouting,
  })
  const output = {
    message: {},
    parts: [
      { type: "text", text: "Route this without changing it.", metadata: { source: "user" } },
      { type: "file", mime: "text/plain", name: "fixture.txt" },
    ],
  }

  await handler({ sessionID, agent: "sisyphus" }, output)
  await runDeferredMacrotask()
  await intentRouting.dispose()

  return {
    parts: structuredClone(output.parts),
    serializedParts: JSON.stringify(output.parts),
    hookOrder,
  }
}

afterEach(() => _resetForTesting())

describe("chat.message Jev intent-routing inertness", () => {
  for (const failureShape of INTENT_ROUTING_FAILURE_SHAPES) {
    test(`#given a backend that ${failureShape} #when the wire is enabled versus disabled #then parts stay byte-identical and hook order stays fixed`, async () => {
      const disabled = await runChatScenario(false, failureShape)
      const enabled = await runChatScenario(true, failureShape)

      expect(enabled.parts).toEqual(disabled.parts)
      expect(enabled.serializedParts).toBe(disabled.serializedParts)
      expect(enabled.hookOrder).toEqual(CHAT_HOOK_ORDER)
      expect(enabled.hookOrder).toEqual(disabled.hookOrder)
      expect(new Set(enabled.hookOrder)).toEqual(new Set(disabled.hookOrder))
    })
  }
})
