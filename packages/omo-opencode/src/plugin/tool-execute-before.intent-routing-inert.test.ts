import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../config/schema/jev"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import {
  createJevIntentRouting,
  type JevIntentRoutingDispatcher,
} from "../features/jev"
import { createToolExecuteBeforeHandler } from "./tool-execute-before"

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
  "writeExistingFileGuard",
  "notepadWriteGuard",
  "questionLabelTruncator",
  "claudeCodeHooks",
  "nonInteractiveEnv",
  "bashFileReadGuard",
  "commentChecker",
  "directoryAgentsInjector",
  "directoryReadmeInjector",
  "rulesInjector",
  "tasksTodowriteDisabler",
  "webfetchRedirectGuard",
  "fsyncSkipWarning",
  "prometheusMdOnly",
  "sisyphusJuniorNotepad",
  "atlasHook",
  "compactionTodoPreserver",
  "teamToolGating",
] as const

type FailureMode = "sync-throw" | "async-reject" | "timeout"
type ToolHooks = Parameters<typeof createToolExecuteBeforeHandler>[0]["hooks"]

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

function orderedHooks(order: string[]): ToolHooks {
  const hooks: Record<string, { "tool.execute.before": () => Promise<void> }> = {}
  for (const name of HOOK_ORDER) {
    hooks[name] = { "tool.execute.before": async () => { order.push(name) } }
  }
  return hooks as ToolHooks
}

async function runHandler(enabled: boolean, mode: FailureMode) {
  const jevConfig = JevConfigSchema.parse({
    enabled,
    backend: "mock",
    wires: { intent_routing: { enabled } },
  })
  let signalStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  const routing = createJevIntentRouting({
    jevConfig,
    dispatcher: dispatcher(mode, () => signalStarted?.()),
    logger: () => {},
  })
  const order: string[] = []
  const handler = createToolExecuteBeforeHandler({
    ctx: { directory: "/tmp/jev-inert", client: {} },
    hooks: orderedHooks(order),
    intentRoutingCapture: routing,
  })
  const output = { args: { command: "pwd", nested: { stable: true } } }

  routing.observe(
    { sessionID: "main" },
    { parts: [{ type: "text", text: "exercise shared backend before capture" }] },
  )
  await handler({ tool: "bash", sessionID: "main", callID: "call-1" }, output)
  if (enabled) await started
  return { bytes: JSON.stringify(output.args), order, output }
}

beforeEach(() => {
  _resetForTesting()
  setMainSession("main")
})
afterEach(() => _resetForTesting())

describe("tool.execute.before Jev intent-routing inertness", () => {
  for (const mode of ["sync-throw", "async-reject", "timeout"] as const) {
    test(`#given a ${mode} backend #when the shared wire is toggled #then args bytes and hook order stay identical`, async () => {
      const disabled = await runHandler(false, mode)
      const enabled = await runHandler(true, mode)

      expect(enabled.output.args).toEqual(disabled.output.args)
      expect(enabled.bytes).toBe(disabled.bytes)
      expect(enabled.order).toEqual(disabled.order)
      expect(enabled.order).toEqual(HOOK_ORDER)
    })
  }
})
