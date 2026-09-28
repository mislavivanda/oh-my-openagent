import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type {
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import { OhMyOpenCodeConfigSchema } from "../../config"
import { createToolRegistry } from "../../plugin/tool-registry"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import {
  _resetForTesting,
  setMainSession,
  subagentSessions,
} from "../claude-code-session-state/state"
import {
  createJevIntentRoutingCapture,
  JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST,
  type JevIntentRoutingCapture,
} from "./intent-routing-capture"
import {
  createIntentRoutingTurnStore,
  type IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-store"

const SESSION_ID = "main-session"

function createHarness(sessionID = SESSION_ID) {
  const entries: IntentRoutingEntry[] = []
  const options: IntentRoutingTurnStoreOptions = {
    maxTrackedSessions: 4,
    maxTurnsPerSession: 4,
    processId: "intent-routing-capture-test",
    sink: (entry) => { entries.push(entry) },
  }
  const store = createIntentRoutingTurnStore(options)
  const turn = store.createTurn({
    sessionID,
    parts: [{ type: "text", text: "delegate work" }],
    questionVersion: 1,
    vocabularyDigest: "vocab-test",
    confidenceThreshold: 0.8,
    configuredModelSpec: "jev-1.13.0",
    predictionTimeoutMs: 100,
    truncatedInput: false,
    notDispatchedReason: "test",
  })
  return {
    capture: createJevIntentRoutingCapture(store),
    entries,
    store,
    turn,
  }
}

function captureWithoutMutation(
  capture: JevIntentRoutingCapture,
  tool: string,
  args: Record<string, unknown>,
  callID = "call-1",
  sessionID = SESSION_ID,
): boolean {
  const before = structuredClone(args)
  const output = { args }
  const captured = capture.capture({ tool, sessionID, callID }, output)
  expect(output.args).toEqual(before)
  return captured
}

function observationRecord(entries: readonly IntentRoutingEntry[]): IntentRoutingObservationRecord | undefined {
  return entries.find((entry): entry is IntentRoutingObservationRecord => entry.kind === "observation")
}

beforeEach(() => {
  _resetForTesting()
  setMainSession(SESSION_ID)
})

afterEach(() => {
  _resetForTesting()
})

describe("createJevIntentRoutingCapture", () => {
  test("#given a task category #when the attempt is captured #then it records one category observation", () => {
    const { capture, store, turn } = createHarness()

    expect(captureWithoutMutation(capture, "task", { category: "deep" })).toBe(true)

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed).toEqual([
      expect.objectContaining({
        tool: "task",
        normalizedCategory: "deep",
        normalizedSubagent: "none",
        routeClass: "category",
      }),
    ])
  })

  test("#given call_omo_agent #when the attempt is captured #then the second delegation tool records an observation", () => {
    const { capture, store, turn } = createHarness()

    expect(captureWithoutMutation(capture, "call_omo_agent", { subagent_type: "explore" })).toBe(true)

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed).toEqual([
      expect.objectContaining({ tool: "call_omo_agent", normalizedSubagent: "explore", routeClass: "subagent" }),
    ])
  })

  test("#given a task_id-only resume #when captured #then it is unscorable_resume rather than none and increments its counter", () => {
    const { capture, store, turn } = createHarness()

    expect(captureWithoutMutation(capture, "task", { task_id: "ses-child" })).toBe(true)

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed).toEqual([
      expect.objectContaining({
        taskId: "ses-child",
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unscorable_resume",
      }),
    ])
    expect(capture.unscorableResumeCalls).toBe(1)
  })

  test("#given an unrecognized category #when captured #then it is unknown and increments its counter", () => {
    const { capture, store, turn } = createHarness()

    expect(captureWithoutMutation(capture, "task", { category: "legacy-category" })).toBe(true)

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed).toEqual([
      expect.objectContaining({ routeClass: "unknown" }),
    ])
    expect(capture.unscorableUnknownCalls).toBe(1)
  })

  test("#given requested and rewritten subagents differ #when captured #then the requested value wins", () => {
    const { capture, store, turn } = createHarness()

    captureWithoutMutation(capture, "task", {
      requested_subagent_type: "librarian",
      subagent_type: "sisyphus-junior",
    })

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed[0]).toEqual(
      expect.objectContaining({
        requestedSubagentType: "librarian",
        subagentType: "sisyphus-junior",
        normalizedSubagent: "librarian",
        routeClass: "subagent",
      }),
    )
  })

  test("#given a non-delegation tool #when capture runs #then it records zero observations", () => {
    const { capture, store, turn } = createHarness()

    expect(captureWithoutMutation(capture, "read", { filePath: "/tmp/example" })).toBe(false)

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.observed).toEqual([])
  })

  test("#given three delegation attempts with a duplicate target #when the turn seals #then one record preserves order and two distinct targets", () => {
    const { capture, entries, store, turn } = createHarness()
    captureWithoutMutation(capture, "task", { category: "deep" }, "call-1")
    captureWithoutMutation(capture, "task", { category: "deep" }, "call-2")
    captureWithoutMutation(capture, "call_omo_agent", { subagent_type: "explore" }, "call-3")

    store.sealTurn(SESSION_ID, turn.turnOrdinal, "session_idle")

    const record = observationRecord(entries)
    expect(record?.observed.map((observation) => observation.callID)).toEqual(["call-1", "call-2", "call-3"])
    expect(record?.observed).toHaveLength(3)
    expect(record?.observedAreAttempts).toBe(true)
    expect(record?.distinctCategoryCount).toBe(1)
    expect(record?.distinctSubagentCount).toBe(1)
  })

  test("#given a subagent session #when a delegation attempt arrives #then the shared session gate excludes it", () => {
    const subagentSessionID = "subagent-session"
    const { capture, store, turn } = createHarness(subagentSessionID)
    subagentSessions.add(subagentSessionID)

    expect(captureWithoutMutation(capture, "task", { category: "deep" }, "call-sub", subagentSessionID)).toBe(false)

    expect(store.getTurn(subagentSessionID, turn.turnOrdinal)?.observed).toEqual([])
  })

  test("#given the registered tool argument schemas #when routing fields are enumerated #then every matching tool is allowlisted", () => {
    const registry = createToolRegistry({
      ctx: unsafeTestValue({ directory: "/tmp/jev-capture-registry", client: {} }),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({ disabled_agents: ["multimodal-looker"] }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
        monitorManager: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      interactiveBashEnabled: false,
    })
    const registeredRoutingTools = Object.entries(registry.filteredTools)
      .filter(([, definition]) => {
        const argumentNames = Object.keys(definition.args)
        return argumentNames.includes("category") || argumentNames.includes("subagent_type")
      })
      .map(([toolName]) => toolName)
      .sort()

    expect(registeredRoutingTools).toEqual([...JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST].sort())
  })
})
