/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { CompletionContinuationHeuristicFacts } from "@oh-my-opencode/jev-core"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { MAX_CONSECUTIVE_FAILURES, MAX_STAGNATION_COUNT } from "./constants"
import { handleSessionIdle } from "./idle-event"
import type { ContinuationProgressUpdate, SessionStateStore } from "./session-state"
import type { MessageWithInfo, SessionState, Todo } from "./types"

type Outcome = CompletionContinuationHeuristicFacts["gauntletOutcome"]

type Scenario = {
  readonly outcome: Outcome
  readonly state?: Partial<SessionState>
  readonly messages?: readonly MessageWithInfo[]
  readonly todos?: readonly Todo[]
  readonly stopped?: boolean
  readonly advanceCompaction?: boolean
  readonly progress?: ContinuationProgressUpdate
}

const NOW = 1_000_000
const PENDING: Todo[] = [{ id: "todo-1", content: "Finish", status: "pending", priority: "high" }]
const BASE_MESSAGES: MessageWithInfo[] = [{ info: { role: "user", agent: "sisyphus" }, parts: [{ type: "text", text: "work" }] }]
const NO_PROGRESS: ContinuationProgressUpdate = {
  previousIncompleteCount: 1,
  previousStagnationCount: 0,
  stagnationCount: 0,
  hasProgressed: false,
  progressSource: "none",
}

const SCENARIOS: readonly Scenario[] = [
  { outcome: "no_todos", todos: [] },
  { outcome: "all_todos_complete", todos: [{ id: "todo-1", content: "Finish", status: "completed", priority: "high" }] },
  { outcome: "injection_in_flight", state: { inFlight: true } },
  { outcome: "max_failures", state: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES, lastInjectedAt: NOW - 500 } },
  { outcome: "cooldown", state: { lastInjectedAt: NOW - 500 } },
  { outcome: "latest_compaction", messages: [{ info: { role: "user" }, parts: [{ type: "compaction" }] }] },
  { outcome: "agent_skipped", messages: [{ info: { role: "user", agent: "prometheus" } }] },
  { outcome: "compaction_agent_unknown", messages: [{ info: { role: "user" }, parts: [{ type: "compaction" }] }, { info: { role: "user" }, parts: [{ type: "text", text: "resume" }] }] },
  { outcome: "compaction_guard", state: { recentCompactionAt: NOW - 1_000, recentCompactionEpoch: 1 }, advanceCompaction: true },
  { outcome: "continuation_stopped", stopped: true },
  { outcome: "turn_boundary_block", state: { continuationBlockReason: "directive-response" } },
  {
    outcome: "stagnation_stop",
    progress: {
      previousIncompleteCount: 1,
      previousStagnationCount: MAX_STAGNATION_COUNT - 1,
      stagnationCount: MAX_STAGNATION_COUNT,
      hasProgressed: false,
      progressSource: "none",
    },
  },
  { outcome: "continuation_scheduled" },
]

function expectedFacts(outcome: Outcome): CompletionContinuationHeuristicFacts {
  const tracked = outcome === "turn_boundary_block" || outcome === "stagnation_stop" || outcome === "continuation_scheduled"
  return {
    gauntletOutcome: outcome,
    todoComplete: outcome === "no_todos" ? null : outcome === "all_todos_complete",
    promiseComplete: false,
    todoProgress: tracked ? false : null,
    stagnationStop: outcome === "stagnation_stop",
  }
}

function createStateStore(scenario: Scenario): { readonly store: SessionStateStore; readonly state: SessionState } {
  const state: SessionState = { stagnationCount: 0, consecutiveFailures: 0, ...scenario.state }
  const store = unsafeTestValue<SessionStateStore>({
    getState: () => state,
    getExistingState: () => state,
    startPruneInterval: () => {},
    trackContinuationProgress: () => scenario.progress ?? NO_PROGRESS,
    resetContinuationProgress: () => {},
    cancelCountdown: () => {
      if (state.countdownTimer) clearTimeout(state.countdownTimer)
      if (state.countdownInterval) clearInterval(state.countdownInterval)
      state.countdownTimer = undefined
      state.countdownInterval = undefined
      state.inFlight = false
      state.countdownStartedAt = undefined
    },
    cleanup: () => {},
    cancelAllCountdowns: () => {},
    shutdown: () => {},
  })
  return { store, state }
}

async function runScenario(scenario: Scenario): Promise<{
  readonly begins: readonly unknown[]
  readonly finishes: readonly CompletionContinuationHeuristicFacts[]
}> {
  const begins: unknown[] = []
  const finishes: CompletionContinuationHeuristicFacts[] = []
  const observer = {
    observeEvent: () => {},
    recordPreInputSkip: () => {},
    beginIdle: (input: unknown) => { begins.push(input) },
    finishHeuristic: (_sessionID: string, facts: CompletionContinuationHeuristicFacts) => { finishes.push(facts) },
    markContinuationActivity: () => {},
    humanIntervention: () => {},
    deleteSession: () => {},
    dispose: () => {},
  }
  const { store, state } = createStateStore(scenario)
  const messages = scenario.messages ?? BASE_MESSAGES
  const todos = scenario.todos ?? PENDING
  const ctx = unsafeTestValue<Parameters<typeof handleSessionIdle>[0]["ctx"]>({
    directory: "/tmp/outcomes",
    client: {
      session: {
        messages: async () => ({ data: messages }),
        todo: async () => {
          if (scenario.advanceCompaction) {
            state.recentCompactionAt = NOW
            state.recentCompactionEpoch = 2
          }
          return { data: todos }
        },
      },
      tui: { showToast: async () => ({}) },
    },
  })
  await handleSessionIdle(unsafeTestValue({
    ctx,
    sessionID: `session-${scenario.outcome}`,
    sessionStateStore: store,
    isContinuationStopped: scenario.stopped ? () => true : undefined,
    completionContinuationObserver: observer,
  }))
  store.cancelCountdown(`session-${scenario.outcome}`)
  return { begins, finishes }
}

describe("completion-continuation gauntlet outcomes", () => {
  test("begins after fetched input and reports every exact post-input outcome", async () => {
    // given
    const originalNow = Date.now
    const originalSetTimeout = globalThis.setTimeout
    const originalSetInterval = globalThis.setInterval
    const originalClearTimeout = globalThis.clearTimeout
    const originalClearInterval = globalThis.clearInterval
    Date.now = () => NOW
    globalThis.setTimeout = unsafeTestValue((_callback: TimerHandler) => 81)
    globalThis.setInterval = unsafeTestValue((_callback: TimerHandler) => 82)
    globalThis.clearTimeout = unsafeTestValue(() => {})
    globalThis.clearInterval = unsafeTestValue(() => {})

    try {
      // when
      const results: Awaited<ReturnType<typeof runScenario>>[] = []
      for (const scenario of SCENARIOS) results.push(await runScenario(scenario))

      // then
      expect(SCENARIOS.map(({ outcome }) => outcome)).toEqual([
        "no_todos", "all_todos_complete", "injection_in_flight", "max_failures", "cooldown",
        "latest_compaction", "agent_skipped", "compaction_agent_unknown", "compaction_guard",
        "continuation_stopped", "turn_boundary_block", "stagnation_stop", "continuation_scheduled",
      ])
      expect(Object.fromEntries(SCENARIOS.map((scenario, index) => [scenario.outcome, results[index]?.begins.length]))).toEqual(
        Object.fromEntries(SCENARIOS.map((scenario) => [scenario.outcome, 1])),
      )
      for (const [index, scenario] of SCENARIOS.entries()) {
        expect(results[index]?.begins).toHaveLength(1)
        expect(results[index]?.finishes).toEqual([expectedFacts(scenario.outcome)])
      }
    } finally {
      Date.now = originalNow
      globalThis.setTimeout = originalSetTimeout
      globalThis.setInterval = originalSetInterval
      globalThis.clearTimeout = originalClearTimeout
      globalThis.clearInterval = originalClearInterval
    }
  })

  test("absorbs an idle without messages or todos before creating an observation", async () => {
    // given
    const begins: unknown[] = []
    const observer = {
      observeEvent: () => {}, recordPreInputSkip: () => {},
      beginIdle: (input: unknown) => { begins.push(input) }, finishHeuristic: () => {},
      markContinuationActivity: () => {}, humanIntervention: () => {}, deleteSession: () => {}, dispose: () => {},
    }
    const { store } = createStateStore({ outcome: "no_todos" })
    const ctx = unsafeTestValue<Parameters<typeof handleSessionIdle>[0]["ctx"]>({
      directory: "/tmp/outcomes",
      client: { session: { messages: async () => { throw new TypeError("missing") }, todo: async () => ({ data: [] }) } },
    })

    // when
    await handleSessionIdle(unsafeTestValue({ ctx, sessionID: "missing-input", sessionStateStore: store, completionContinuationObserver: observer }))

    // then
    expect(begins).toEqual([])
  })
})
