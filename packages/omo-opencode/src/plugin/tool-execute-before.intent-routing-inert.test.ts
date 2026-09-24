import { afterEach, describe, expect, test } from "bun:test"
import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
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
import { createToolExecuteBeforeHandler } from "./tool-execute-before"

const SESSION_ID = "ses-tool-inert"
const FAILURE_MODES = ["sync_throw", "async_reject", "timeout"] as const
type FailureMode = typeof FAILURE_MODES[number]

const SINK: IntentRoutingSink = {
  processId: "tool-inert-test",
  filePath: "/tmp/tool-inert-test.jsonl",
  counterEpoch: 0,
  write: () => true,
  dispose() {},
}

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

async function settleFailure(mode: FailureMode): Promise<void> {
  const delayMs = mode === "timeout" ? 120 : 0
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  await Promise.resolve()
}

async function runToolExecuteBefore(mode: FailureMode, wireEnabled: boolean) {
  const hookOrder: string[] = []
  const jevConfig = createConfig(wireEnabled)
  const routing = createJevIntentRouting({
    jevConfig,
    vocab: JEV_INTENT_ROUTING_VOCABULARY,
    dispatcher: createDispatcher(mode),
    logger: () => {},
    sink: SINK,
  })
  routing.dispatch(
    { sessionID: SESSION_ID },
    { parts: [{ type: "text", text: `seed ${mode}` }] },
  )
  await settleFailure(mode)
  const beforeHook = (name: string) => ({
    "tool.execute.before": async () => {
      hookOrder.push(name)
    },
  })
  const handler = createToolExecuteBeforeHandler({
    ctx: unsafeTestValue({ directory: process.cwd(), client: {} }),
    hooks: unsafeTestValue({
      writeExistingFileGuard: beforeHook("write-existing-file-guard"),
      questionLabelTruncator: beforeHook("question-label-truncator"),
      rulesInjector: beforeHook("rules-injector"),
    }),
    pluginConfig: unsafeTestValue({ jev: jevConfig }),
    intentRouting: routing,
  })
  const output = {
    args: {
      description: "inspect routing",
      prompt: "find the relevant call path",
      subagent_type: "explore",
      nested: { stable: true, order: [1, 2, 3] },
    } as Record<string, unknown>,
  }

  await handler(
    { tool: "call_omo_agent", sessionID: SESSION_ID, callID: `call-${mode}` },
    output,
  )
  routing.handleSessionIdle(SESSION_ID)
  await routing.dispose()

  return {
    args: output.args,
    serialized: JSON.stringify(output.args),
    hookOrder,
  }
}

afterEach(() => {
  _resetForTesting()
})

describe("tool.execute.before intent-routing inertness", () => {
  test.each(FAILURE_MODES)("#given a %s backend #when the wire is enabled versus disabled #then args stay byte-identical and other hooks keep their set and order", async (mode) => {
    setMainSession(SESSION_ID)
    const disabled = await runToolExecuteBefore(mode, false)
    const enabled = await runToolExecuteBefore(mode, true)
    const expectedOrder = [
      "write-existing-file-guard",
      "question-label-truncator",
      "rules-injector",
    ]

    expect(enabled.serialized).toBe(disabled.serialized)
    expect(Buffer.compare(Buffer.from(enabled.serialized), Buffer.from(disabled.serialized))).toBe(0)
    expect(enabled.args).toEqual(disabled.args)
    expect(enabled.hookOrder).toEqual(disabled.hookOrder)
    expect(enabled.hookOrder).toEqual(expectedOrder)
    expect(new Set(enabled.hookOrder)).toEqual(new Set(expectedOrder))
  })
})
