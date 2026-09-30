import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import { describe, expect, spyOn, test } from "bun:test"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { BackgroundManager } from "../../features/background-agent"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import * as logger from "../../shared/logger"
import { MAX_CONSECUTIVE_FAILURES, MAX_STAGNATION_COUNT } from "./constants"
import { handleSessionIdle } from "./idle-event"
import type { ContinuationProgressUpdate, SessionStateStore } from "./session-state"
import type { MessageWithInfo, SessionState, Todo } from "./types"

const GOLDEN_PATH = resolve(import.meta.dir, "../../../../../.omo/evidence/20260930-jev-w2/task-13-pre-extraction-golden.json")
const EXPECTED_GOLDEN_SHA256 = "361d26ff4dc0dfdf6eb6d794c765dcf346b2b8578590c9f2a2492b100e3ed2e4"
const NOW = 1_000_000
const PENDING_TODOS: Todo[] = [{ id: "todo-1", content: "Finish", status: "pending", priority: "high" }]
const DEFAULT_PROGRESS: ContinuationProgressUpdate = {
  previousStagnationCount: 0,
  stagnationCount: 0,
  hasProgressed: false,
  progressSource: "none",
}

type TraceEntry = readonly [string, ...unknown[]]
type TraceMap = Record<string, TraceEntry[]>
type Scenario = {
  readonly name: string
  readonly state?: Partial<SessionState>
  readonly messages?: MessageWithInfo[]
  readonly todos?: Todo[]
  readonly messagesFailure?: unknown
  readonly todoFailure?: unknown
  readonly background?: "running" | "pending-wake"
  readonly handedBack?: boolean
  readonly stopped?: boolean
  readonly advanceCompactionOnTodo?: boolean
  readonly progress?: ContinuationProgressUpdate
}

const SCENARIOS: readonly Scenario[] = [
  { name: "all-todos-already-completed", state: { allTodosCompletedAt: 123 } },
  { name: "recovery-active", state: { isRecovering: true } },
  { name: "session-cancelled", state: { wasCancelled: true } },
  { name: "sync-subagent-handed-back", handedBack: true },
  { name: "token-limit-detected", state: { tokenLimitDetected: true } },
  { name: "recent-abort", state: { abortDetectedAt: NOW - 1_000 } },
  { name: "background-task-running", background: "running" },
  { name: "last-assistant-aborted", messages: [{ info: { role: "assistant", error: { name: "AbortError" } } }] },
  { name: "question-awaiting-user", messages: unsafeTestValue([{ info: { role: "assistant" }, parts: [{ type: "tool_use", name: "question" }] }]) },
  { name: "internal-response-pending", messages: unsafeTestValue([
    { info: { role: "user" }, parts: [{ type: "text", text: "continue\n<!-- OMO_INTERNAL_INITIATOR -->", synthetic: true }] },
    { info: { role: "assistant", finish: "unknown", time: { completed: NOW } }, parts: [{ type: "step-start" }, { type: "step-finish", reason: "unknown" }] },
  ]) },
  { name: "messages-fetch-failure", messagesFailure: new Error("messages failed") },
  { name: "todo-fetch-failure", todoFailure: new Error("todos failed") },
  { name: "no-todos", todos: [] },
  { name: "all-todos-complete", todos: [{ id: "todo-1", content: "Finish", status: "completed", priority: "high" }] },
  { name: "injection-in-flight", state: unsafeTestValue({ inFlight: true, countdownTimer: 71, countdownInterval: 72 }) },
  { name: "max-failures-before-cooldown", state: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES, lastInjectedAt: NOW - 500 } },
  { name: "cooldown-active", state: { lastInjectedAt: NOW - 500 } },
  { name: "latest-message-compaction", messages: [{ info: { role: "user" }, parts: [{ type: "compaction" }] }] },
  { name: "agent-skipped", messages: [{ info: { role: "user", agent: "prometheus" } }] },
  { name: "compaction-without-agent", messages: [{ info: { role: "user" }, parts: [{ type: "compaction" }] }, { info: { role: "assistant" } }] },
  { name: "compaction-guard-active", state: { recentCompactionAt: NOW - 1_000, recentCompactionEpoch: 1 }, messages: [{ info: { role: "user", agent: "sisyphus" } }], advanceCompactionOnTodo: true },
  { name: "continuation-stopped", stopped: true },
  { name: "turn-boundary-paused", state: { continuationBlockReason: "directive-response" } },
  { name: "stagnation-limit", progress: { previousIncompleteCount: 1, previousStagnationCount: MAX_STAGNATION_COUNT - 1, stagnationCount: MAX_STAGNATION_COUNT, hasProgressed: false, progressSource: "none" } },
  { name: "stale-abort-falls-through", state: { abortDetectedAt: NOW - 10_000 } },
  { name: "failure-reset-falls-through", state: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES, lastInjectedAt: NOW - 400_000 } },
  { name: "countdown-starts" },
]
const GUARD_SCENARIO_COUNT = 24

function createState(scenario: Scenario, trace: TraceEntry[]): SessionState {
  const rawState: SessionState = { stagnationCount: 0, consecutiveFailures: 0, ...scenario.state }
  return new Proxy(rawState, {
    set(target, property, value): boolean {
      trace.push(["state", String(property), value ?? null])
      return Reflect.set(target, property, value)
    },
  })
}

async function runScenario(scenario: Scenario): Promise<TraceEntry[]> {
  const trace: TraceEntry[] = []
  const state = createState(scenario, trace)
  const sessionID = `ses-${scenario.name}`
  const original = { now: Date.now, setTimeout, setInterval, clearTimeout, clearInterval }
  let timerID = 100
  const logSpy = spyOn(logger, "log").mockImplementation((message: string, data?: unknown) => trace.push(["log", message, data ?? null]))
  Date.now = () => NOW
  globalThis.setTimeout = unsafeTestValue((_callback: TimerHandler, delay?: number) => { trace.push(["timer", "setTimeout", delay ?? 0]); return timerID++ })
  globalThis.setInterval = unsafeTestValue((_callback: TimerHandler, delay?: number) => { trace.push(["timer", "setInterval", delay ?? 0]); return timerID++ })
  globalThis.clearTimeout = unsafeTestValue((handle?: number) => trace.push(["timer", "clearTimeout", handle ?? null]))
  globalThis.clearInterval = unsafeTestValue((handle?: number) => trace.push(["timer", "clearInterval", handle ?? null]))
  if (scenario.handedBack) handedBackSyncSessions.add(sessionID)
  const store = unsafeTestValue<SessionStateStore>({
    getState: () => state,
    getExistingState: () => state,
    startPruneInterval: () => {},
    trackContinuationProgress: () => { trace.push(["state-store", "trackContinuationProgress"]); return scenario.progress ?? DEFAULT_PROGRESS },
    resetContinuationProgress: () => trace.push(["state-store", "resetContinuationProgress"]),
    cancelCountdown: () => {
      trace.push(["state-store", "cancelCountdown"])
      if (state.countdownTimer) { clearTimeout(state.countdownTimer); state.countdownTimer = undefined }
      if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = undefined }
      state.inFlight = false
      state.countdownStartedAt = undefined
    },
    cleanup: () => {}, cancelAllCountdowns: () => {}, shutdown: () => {},
  })
  const backgroundManager = scenario.background ? unsafeTestValue<BackgroundManager>({
    getTasksByParentSession: () => { trace.push(["manager", "getTasksByParentSession"]); return scenario.background === "running" ? [{ status: "running" }] : [] },
    hasPendingParentWake: () => { trace.push(["manager", "hasPendingParentWake"]); return scenario.background === "pending-wake" },
  }) : undefined
  const ctx = unsafeTestValue<PluginInput>({ directory: "/tmp/test", client: { session: {
    messages: async () => { trace.push(["client", "session.messages"]); if (scenario.messagesFailure) throw scenario.messagesFailure; return { data: scenario.messages ?? [] } },
    todo: async () => {
      trace.push(["client", "session.todo"])
      if (scenario.todoFailure) throw scenario.todoFailure
      if (scenario.advanceCompactionOnTodo) { state.recentCompactionAt = NOW; state.recentCompactionEpoch = 2 }
      return { data: scenario.todos ?? PENDING_TODOS }
    },
  }, tui: { showToast: async () => { trace.push(["client", "tui.showToast"]); return {} } } } })
  trace.push(["snapshot", "before", { ...state }])
  try {
    await handleSessionIdle({ ctx, sessionID, sessionStateStore: store, backgroundManager, isContinuationStopped: scenario.stopped ? () => { trace.push(["decision", "isContinuationStopped"]); return true } : undefined })
  } finally {
    trace.push(["snapshot", "after", { ...state }])
    handedBackSyncSessions.delete(sessionID)
    logSpy.mockRestore()
    Date.now = original.now
    globalThis.setTimeout = original.setTimeout
    globalThis.setInterval = original.setInterval
    globalThis.clearTimeout = original.clearTimeout
    globalThis.clearInterval = original.clearInterval
  }
  return trace
}

async function captureAll(): Promise<TraceMap> {
  const traces: TraceMap = {}
  for (const scenario of SCENARIOS) traces[scenario.name] = await runScenario(scenario)
  return traces
}

function serialize(traces: TraceMap): string {
  return `${JSON.stringify(traces, null, 2)}\n`
}

describe("idle event characterization", () => {
  test("matches the no-clobber pre-extraction golden bytes", async () => {
    const bytes = serialize(await captureAll())
    if (process.env.OMO_CAPTURE_IDLE_GOLDEN === "1") writeFileSync(GOLDEN_PATH, bytes, { flag: "wx" })
    expect(bytes).toBe(readFileSync(GOLDEN_PATH, "utf8"))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_GOLDEN_SHA256)
  })

  test("records a nonempty ordered trace for every guard branch", async () => {
    const traces = await captureAll()
    expect(SCENARIOS.slice(0, GUARD_SCENARIO_COUNT)).toHaveLength(GUARD_SCENARIO_COUNT)
    for (const scenario of SCENARIOS.slice(0, GUARD_SCENARIO_COUNT)) {
      expect(traces[scenario.name]?.length).toBeGreaterThan(2)
      expect(traces[scenario.name]?.some(([kind]) => kind === "log")).toBe(true)
    }
  })

  test("detects reordered cooldown and failure guards", async () => {
    expect(serialize(await captureAll())).toBe(readFileSync(GOLDEN_PATH, "utf8"))
  })
})
