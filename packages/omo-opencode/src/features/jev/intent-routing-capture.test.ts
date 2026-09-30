import { describe, expect, test } from "bun:test"
import type { IntentRoutingEntry } from "@oh-my-opencode/jev-core"
import {
  _resetForTesting,
  setMainSession,
  subagentSessions,
} from "../claude-code-session-state"
import { createToolExecuteBeforeHandler } from "../../plugin/tool-execute-before"
import {
  JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST,
  createJevIntentRoutingCapture,
} from "./intent-routing-capture"
import { registeredRoutingFieldToolNames } from "./intent-routing-capture-registry.test-support"
import { createIntentRoutingTurnStore } from "./intent-routing-turn-store"
import { baseTurn } from "./intent-routing-turn-store.test-support"
import type { IntentRoutingTurnStore } from "./intent-routing-turn-types"

const MAIN_SESSION_ID = "main-session"

type CaptureHarness = {
  readonly capture: ReturnType<typeof createJevIntentRoutingCapture>
  readonly entries: IntentRoutingEntry[]
  readonly store: IntentRoutingTurnStore
  readonly turnOrdinal: number
}

function createHarness(): CaptureHarness {
  _resetForTesting()
  setMainSession(MAIN_SESSION_ID)
  const entries: IntentRoutingEntry[] = []
  const store = createIntentRoutingTurnStore({ onEntry: (entry) => entries.push(entry) })
  const turn = store.startTurn(baseTurn(MAIN_SESSION_ID, "delegate this work"))
  if (turn === null) throw new TypeError("expected an active intent-routing turn")
  return {
    capture: createJevIntentRoutingCapture({ turnStore: store }),
    entries,
    store,
    turnOrdinal: turn.turnOrdinal,
  }
}

function captureWithoutMutation(
  harness: CaptureHarness,
  input: { readonly tool: unknown; readonly callID?: unknown; readonly sessionID?: unknown },
  args: unknown,
): boolean {
  const output = { args }
  const before = structuredClone(args)
  const captured = harness.capture.capture(input, output)
  expect(output.args).toEqual(before)
  return captured
}

function observed(harness: CaptureHarness) {
  return harness.store.getTurn(MAIN_SESSION_ID, harness.turnOrdinal)?.observed ?? []
}

describe("JEV intent-routing delegation capture", () => {
  test("#given a task category #when the before seam runs #then it captures a category attempt", () => {
    const harness = createHarness()

    expect(captureWithoutMutation(harness, {
      tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-category",
    }, { category: "deep" })).toBe(true)

    expect(observed(harness)).toEqual([expect.objectContaining({
      tool: "task",
      routeClass: "category",
      normalizedCategory: "deep",
      normalizedSubagent: "none",
    })])
  })

  test("#given call_omo_agent #when the before seam runs #then it captures the second delegation tool", () => {
    const harness = createHarness()

    captureWithoutMutation(harness, {
      tool: "call_omo_agent", sessionID: MAIN_SESSION_ID, callID: "call-agent",
    }, { subagent_type: "explore" })

    expect(observed(harness)).toEqual([expect.objectContaining({
      tool: "call_omo_agent",
      routeClass: "subagent",
      normalizedSubagent: "explore",
    })])
  })

  test("#given the plugin before handler #when call_omo_agent runs #then the handler invokes capture without changing args", async () => {
    const harness = createHarness()
    const handler = createToolExecuteBeforeHandler({
      ctx: { client: {} } as Parameters<typeof createToolExecuteBeforeHandler>[0]["ctx"],
      hooks: {},
      intentRoutingCapture: harness.capture,
    })
    const output = { args: { subagent_type: "librarian" } }
    const before = structuredClone(output.args)

    await handler({
      tool: "call_omo_agent", sessionID: MAIN_SESSION_ID, callID: "call-handler",
    }, output)

    expect(output.args).toEqual(before)
    expect(observed(harness)[0]).toMatchObject({
      tool: "call_omo_agent", normalizedSubagent: "librarian", callID: "call-handler",
    })
  })

  test("#given a task resume #when captured before agent resolution #then it is unscorable and counted", () => {
    const harness = createHarness()

    captureWithoutMutation(harness, {
      tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-resume",
    }, { task_id: "ses-resume" })

    expect(observed(harness)).toEqual([expect.objectContaining({
      routeClass: "unscorable_resume",
      normalizedCategory: "none",
      normalizedSubagent: "none",
      taskId: "ses-resume",
    })])
    expect(harness.store.getCounters().unscorableResumeCalls).toBe(1)
  })

  test("#given requested and rewritten subagents #when captured #then the requested value wins", () => {
    const harness = createHarness()

    captureWithoutMutation(harness, {
      tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-requested",
    }, { requested_subagent_type: "oracle", subagent_type: "sisyphus-junior" })

    expect(observed(harness)[0]).toMatchObject({
      requestedSubagentType: "oracle",
      subagentType: "sisyphus-junior",
      normalizedSubagent: "oracle",
      routeClass: "subagent",
    })
  })

  test("#given a non-delegation tool #when the before seam runs #then it records nothing", () => {
    const harness = createHarness()

    expect(captureWithoutMutation(harness, {
      tool: "read", sessionID: MAIN_SESSION_ID, callID: "call-read",
    }, { filePath: "/tmp/input" })).toBe(false)

    expect(observed(harness)).toEqual([])
  })

  test("#given three attempts with a duplicate target #when sealed #then one record preserves order and distinct counts", () => {
    const harness = createHarness()
    captureWithoutMutation(harness, { tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-1" }, { category: "deep" })
    captureWithoutMutation(harness, { tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-2" }, { category: "deep" })
    captureWithoutMutation(harness, { tool: "call_omo_agent", sessionID: MAIN_SESSION_ID, callID: "call-3" }, { subagent_type: "explore" })

    harness.store.sealTurn({ sessionID: MAIN_SESSION_ID, turnOrdinal: harness.turnOrdinal, sealedBy: "session_idle" })
    const record = harness.entries.find((entry) => entry.kind === "observation")

    expect(record?.kind).toBe("observation")
    if (record?.kind !== "observation") return
    expect(record.observed.map((entry) => entry.callID)).toEqual(["call-1", "call-2", "call-3"])
    expect(record.observed).toHaveLength(3)
    expect(record.observedAreAttempts).toBe(true)
    expect(record.distinctCategoryCount).toBe(1)
    expect(record.distinctSubagentCount).toBe(1)
  })

  test("#given a subagent session #when it delegates #then the shared eligibility gate protects the parent turn", () => {
    const harness = createHarness()
    subagentSessions.add("child-session")

    expect(captureWithoutMutation(harness, {
      tool: "task", sessionID: "child-session", callID: "call-child",
    }, { category: "deep" })).toBe(false)

    expect(observed(harness)).toEqual([])
  })

  test.each([
    ["null args", null, {}, "unknown", null],
    ["undefined args", undefined, {}, "unknown", null],
    ["non-object args", 42, {}, "unknown", null],
    ["wrong category type", { category: 42 }, {}, "unknown", null],
    ["both routing fields", { category: "deep", subagent_type: "oracle" }, {}, "category", null],
    ["empty task id", { task_id: "" }, {}, "unknown", null],
    ["missing call id", { category: "quick" }, { omitCallID: true }, "category", null],
  ])("#given malformed %s #when captured #then it is inert and normalized without throwing", (
    _name,
    args,
    options,
    expectedRouteClass,
    _unused,
  ) => {
    const harness = createHarness()
    const input = "omitCallID" in options
      ? { tool: "task", sessionID: MAIN_SESSION_ID }
      : { tool: "task", sessionID: MAIN_SESSION_ID, callID: "call-malformed" }

    expect(() => captureWithoutMutation(harness, input, args)).not.toThrow()
    expect(observed(harness)[0]?.routeClass).toBe(expectedRouteClass)
    if ("omitCallID" in options) expect(observed(harness)[0]?.callID).toBeNull()
  })

  test("#given every registered schema #when routing fields are enumerated #then the capture allowlist cannot drift", () => {
    expect([...JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST].sort()).toEqual(
      registeredRoutingFieldToolNames(),
    )
  })
})
