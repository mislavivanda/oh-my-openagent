import { describe, expect, test } from "bun:test"
import type { IntentRoutingCounters, IntentRoutingObservationRecord } from "@oh-my-opencode/jev-core"
import { OhMyOpenCodeConfigSchema } from "../../config"
import { createToolRegistry } from "../../plugin/tool-registry"

type CaptureRecord = Pick<IntentRoutingObservationRecord,
  "observed" | "observedAreAttempts" | "distinctCategoryCount" | "distinctSubagentCount">
type CaptureCounters = Pick<IntentRoutingCounters,
  "orphanObservations" | "unscorableResumeCalls" | "unscorableUnknownCalls">
type CaptureResult = {
  readonly captured: boolean
  readonly record: CaptureRecord | null
  readonly counters: CaptureCounters
}
type CaptureModule = {
  readonly INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST: readonly string[]
  readonly captureIntentRoutingDelegation: (args: CaptureInput) => CaptureResult
}
type CaptureInput = {
  readonly input: { readonly tool: string; readonly sessionID: string; readonly callID: string }
  readonly output: { readonly args: Record<string, unknown> }
  readonly mainSessionID: string | undefined
  readonly isSubagentSession: boolean
  readonly offeredCategories: readonly { readonly name: string; readonly description: string }[]
  readonly record: CaptureRecord | null
  readonly counters: CaptureCounters
}

const modulePath: string = "./intent-routing-capture"
const loadedModule: unknown = await import(modulePath).catch(() => null)

function requireCaptureModule(): CaptureModule {
  expect(
    loadedModule,
    "intent-routing capture must exist before delegation attempts can be recorded",
  ).not.toBeNull()
  if (typeof loadedModule !== "object" || loadedModule === null) {
    throw new TypeError("intent-routing capture module is unavailable")
  }
  const capture = Reflect.get(loadedModule, "captureIntentRoutingDelegation")
  const allowlist = Reflect.get(loadedModule, "INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST")
  expect(capture, "captureIntentRoutingDelegation must be exported").toBeFunction()
  expect(allowlist, "delegation tool allowlist must be exported").toBeArray()
  if (typeof capture !== "function" || !Array.isArray(allowlist)) {
    throw new TypeError("intent-routing capture exports are invalid")
  }
  return {
    captureIntentRoutingDelegation: capture,
    INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST: allowlist,
  }
}

const emptyRecord = (): CaptureRecord => ({
  observed: [],
  observedAreAttempts: true,
  distinctCategoryCount: 0,
  distinctSubagentCount: 0,
})
const emptyCounters = (): CaptureCounters => ({
  orphanObservations: 0,
  unscorableResumeCalls: 0,
  unscorableUnknownCalls: 0,
})

function capture(
  tool: string,
  args: Record<string, unknown>,
  options: {
    readonly callID?: string
    readonly sessionID?: string
    readonly mainSessionID?: string | undefined
    readonly isSubagentSession?: boolean
    readonly record?: CaptureRecord | null
    readonly counters?: CaptureCounters
  } = {},
): CaptureResult {
  const output = { args }
  const before = structuredClone(output.args)
  const result = requireCaptureModule().captureIntentRoutingDelegation({
    input: {
      tool,
      sessionID: options.sessionID ?? "main-session",
      callID: options.callID ?? "call-1",
    },
    output,
    mainSessionID: Object.hasOwn(options, "mainSessionID")
      ? options.mainSessionID
      : "main-session",
    isSubagentSession: options.isSubagentSession ?? false,
    offeredCategories: [
      { name: "deep", description: "Built-in category." },
      { name: "project-special", description: "Configured custom category." },
    ],
    record: options.record === undefined ? emptyRecord() : options.record,
    counters: options.counters ?? emptyCounters(),
  })
  expect(output.args).toEqual(before)
  return result
}
describe("#given tool.execute.before delegation attempts", () => {
  test("#when task supplies only category #then one category observation is captured without args mutation", () => {
    const result = capture("task", { category: "deep" })
    expect(result.record?.observed).toHaveLength(1)
    expect(result.record?.observed[0]).toMatchObject({
      tool: "task",
      routeClass: "category",
      normalizedCategory: "deep",
      normalizedSubagent: "none",
    })
    expect(result.record?.observedAreAttempts).toBe(true)
  })
  test("#when call_omo_agent supplies its required subagent #then the second delegation tool is captured", () => {
    const result = capture("call_omo_agent", { subagent_type: "explore" })
    expect(result.record?.observed[0]).toMatchObject({
      tool: "call_omo_agent",
      routeClass: "subagent",
      normalizedSubagent: "explore",
    })
  })
  test("#when task supplies only task_id #then resume is unscorable and never enters the none bucket", () => {
    const result = capture("task", { task_id: "ses_resume" })
    expect(result.record?.observed[0]?.routeClass).toBe("unscorable_resume")
    expect(result.counters.unscorableResumeCalls).toBe(1)
    expect(result.record?.observed[0]?.routeClass).not.toBe("none")
  })
  test("#when requested_subagent_type differs from rewritten subagent_type #then the requested target wins", () => {
    const result = capture("task", {
      requested_subagent_type: "oracle",
      subagent_type: "sisyphus-junior",
    })
    expect(result.record?.observed[0]).toMatchObject({
      requestedSubagentType: "oracle",
      subagentType: "sisyphus-junior",
      normalizedSubagent: "oracle",
    })
  })
  test("#when a non-delegation tool runs #then zero observations are captured", () => {
    const result = capture("read", { filePath: "/tmp/file" })
    expect(result.captured).toBe(false)
    expect(result.record?.observed).toEqual([])
  })
  test("#when three calls share a turn #then ordered attempts retain distinct target counts", () => {
    const first = capture("task", { category: "deep" }, { callID: "call-1" })
    const second = capture("task", { category: "deep" }, {
      callID: "call-2",
      record: first.record,
      counters: first.counters,
    })
    const third = capture("call_omo_agent", { subagent_type: "explore" }, {
      callID: "call-3",
      record: second.record,
      counters: second.counters,
    })
    expect(third.record?.observed.map(({ callID }) => callID)).toEqual(["call-1", "call-2", "call-3"])
    expect(third.record?.observed).toHaveLength(3)
    expect(third.record?.distinctCategoryCount).toBe(1)
    expect(third.record?.distinctSubagentCount).toBe(1)
  })
  test.each([
    ["unknown main session", { mainSessionID: undefined }],
    ["different main session", { sessionID: "child-session" }],
    ["known subagent session", { isSubagentSession: true }],
  ])("#when capture sees %s #then the fail-closed session gate records nothing", (_case, options) => {
    const result = capture("task", { category: "deep" }, options)
    expect(result.captured).toBe(false)
    expect(result.record?.observed).toEqual([])
  })
})

describe("#given the complete native tool registry", () => {
  test("#when schemas expose category or subagent_type #then every such tool is allowlisted", () => {
    const config = OhMyOpenCodeConfigSchema.parse({
      team_mode: { enabled: true },
      monitor: { enabled: true },
      experimental: { task_system: true },
      hashline_edit: true,
      goal: { enabled: true },
    })
    const result = createToolRegistry({
      ctx: { directory: "/tmp", client: {} } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: config,
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        monitorManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      interactiveBashEnabled: true,
    })
    const schemaDelegationTools = Object.entries(result.filteredTools)
      .filter(([, definition]) =>
        Object.hasOwn(definition.args, "category") || Object.hasOwn(definition.args, "subagent_type"))
      .map(([name]) => name)
      .sort()
    const allowlist = [...requireCaptureModule().INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST].sort()
    expect(schemaDelegationTools).toEqual(allowlist)
  })
})
