import { afterEach, describe, expect, test } from "bun:test"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { CreatedHooks } from "../create-hooks"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import {
  createInertRouting,
  INTENT_ROUTING_FAILURE_SHAPES,
  runDeferredMacrotask,
  TOOL_HOOK_ORDER,
  type IntentRoutingFailureShape,
} from "./intent-routing-inert.test-support"
import { createToolExecuteBeforeHandler } from "./tool-execute-before"
import type { PluginContext } from "./types"

function toolHook(order: string[], name: string) {
  return { "tool.execute.before": async () => { order.push(name) } }
}

function createToolHookLedger(order: string[]): CreatedHooks {
  return unsafeTestValue<CreatedHooks>({
    writeExistingFileGuard: toolHook(order, "writeExistingFileGuard"),
    notepadWriteGuard: toolHook(order, "notepadWriteGuard"),
    questionLabelTruncator: toolHook(order, "questionLabelTruncator"),
    claudeCodeHooks: toolHook(order, "claudeCodeHooks"),
    nonInteractiveEnv: toolHook(order, "nonInteractiveEnv"),
    bashFileReadGuard: toolHook(order, "bashFileReadGuard"),
    commentChecker: toolHook(order, "commentChecker"),
    directoryAgentsInjector: toolHook(order, "directoryAgentsInjector"),
    directoryReadmeInjector: toolHook(order, "directoryReadmeInjector"),
    rulesInjector: toolHook(order, "rulesInjector"),
    tasksTodowriteDisabler: toolHook(order, "tasksTodowriteDisabler"),
    webfetchRedirectGuard: toolHook(order, "webfetchRedirectGuard"),
    fsyncSkipWarning: toolHook(order, "fsyncSkipWarning"),
    prometheusMdOnly: toolHook(order, "prometheusMdOnly"),
    sisyphusJuniorNotepad: toolHook(order, "sisyphusJuniorNotepad"),
    atlasHook: toolHook(order, "atlasHook"),
    compactionTodoPreserver: toolHook(order, "compactionTodoPreserver"),
    teamToolGating: toolHook(order, "teamToolGating"),
  })
}

function pluginContext(): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: process.cwd(),
    client: { session: { messages: async () => ({ data: [] }) } },
  })
}

type ToolScenarioResult = {
  readonly args: Readonly<Record<string, unknown>>
  readonly serializedArgs: string
  readonly hookOrder: readonly string[]
}

async function runToolScenario(
  enabled: boolean,
  failureShape: IntentRoutingFailureShape,
): Promise<ToolScenarioResult> {
  _resetForTesting()
  const sessionID = `session-${enabled ? "enabled" : "disabled"}-${failureShape}`
  setMainSession(sessionID)
  const hookOrder: string[] = []
  const intentRouting = createInertRouting(enabled, failureShape)
  intentRouting.observe(
    { sessionID },
    { parts: [{ type: "text", text: "Delegate this task." }] },
  )
  const handler = createToolExecuteBeforeHandler({
    ctx: pluginContext(),
    hooks: createToolHookLedger(hookOrder),
    intentRouting,
  })
  const output = {
    args: {
      category: "quick",
      description: "Prove the task rewrite remains stable",
      prompt: "Inspect the routing seam",
    },
  }

  await handler({ tool: "task", sessionID, callID: "call-1" }, output)
  await runDeferredMacrotask()
  await intentRouting.dispose()

  return {
    args: structuredClone(output.args),
    serializedArgs: JSON.stringify(output.args),
    hookOrder,
  }
}

afterEach(() => _resetForTesting())

describe("tool.execute.before Jev intent-routing inertness", () => {
  for (const failureShape of INTENT_ROUTING_FAILURE_SHAPES) {
    test(`#given a backend that ${failureShape} #when the wire is enabled versus disabled #then args stay byte-identical and hook order stays fixed`, async () => {
      const disabled = await runToolScenario(false, failureShape)
      const enabled = await runToolScenario(true, failureShape)

      expect(enabled.args).toEqual(disabled.args)
      expect(enabled.serializedArgs).toBe(disabled.serializedArgs)
      expect(enabled.hookOrder).toEqual(TOOL_HOOK_ORDER)
      expect(enabled.hookOrder).toEqual(disabled.hookOrder)
      expect(new Set(enabled.hookOrder)).toEqual(new Set(disabled.hookOrder))
      expect(enabled.args).toEqual({
        category: "quick",
        description: "Prove the task rewrite remains stable",
        prompt: "Inspect the routing seam",
        subagent_type: "sisyphus-junior",
      })
    })
  }
})
