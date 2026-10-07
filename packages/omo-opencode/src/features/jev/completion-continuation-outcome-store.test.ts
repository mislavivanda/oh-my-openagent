/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type {
  CompletionContinuationDecisionResult,
  CompletionContinuationEntry,
  CompletionContinuationHeuristicFacts,
  CompletionContinuationInputTruncations,
} from "@oh-my-opencode/jev-core"
import { classifyCompletionContinuationOutcome } from "./completion-continuation-outcome-classification"
import { captureCompletionContinuationInput } from "./completion-continuation-input"
import { createCompletionContinuationOutcomeStore } from "./completion-continuation-outcome-store"

const TRUNCATIONS: CompletionContinuationInputTruncations = {
  todoItems: false, todoContent: false, transcriptMessages: false, transcriptContent: false,
  diffPaths: false, diffContent: false, boulderContent: false, state: false,
}
const HEURISTIC: CompletionContinuationHeuristicFacts = {
  gauntletOutcome: "continuation_scheduled",
  todoComplete: false,
  promiseComplete: false,
  todoProgress: false,
  stagnationStop: false,
}
const PREDICTION: CompletionContinuationDecisionResult = {
  predictionStatus: "filled",
  unavailableReason: null,
  resolvedModel: "jev-test",
  latencyMs: 7,
  probabilities: { actuallyComplete: 0.2, progressing: 0.8, stuck: 0.1 },
  thresholdLabels: { actuallyComplete: "would_false", progressing: "would_true", stuck: "would_false" },
  invalidAnswerCount: 0,
  threshold: 0.8,
  questionVersion: 1,
}

function snapshot(statuses: readonly string[], tag = "same", boulder: { total: number; completed: number; remaining: number } | null = null) {
  const captured = captureCompletionContinuationInput({
    todos: statuses.map((status, index) => ({ id: `todo-${index}`, status, content: `task-${index}` })),
    transcript: [{ role: "assistant", content: tag }],
    diff: null,
    now: () => 1_000,
  })
  return {
    ...captured,
    input: { ...captured.input, boulder: boulder === null ? null : { ...boulder, nextTaskTitle: null } },
    inputDigests: { ...captured.inputDigests, boulder: boulder === null ? null : `b:${boulder.total}:${boulder.completed}:${boulder.remaining}` },
  }
}

function fakeClock() {
  const timers: { delayMs: number; callback: () => void; active: boolean; unrefCalls: number }[] = []
  return {
    clock: {
      now: () => 1_000,
      schedule: (delayMs: number, callback: () => void) => {
        const timer = { delayMs, callback, active: true, unrefCalls: 0 }
        timers.push(timer)
        return {
          cancel: () => { timer.active = false },
          unref: () => { timer.unrefCalls += 1 },
        }
      },
    },
    timers,
    fire: (index: number) => {
      const timer = timers[index]
      if (timer?.active) { timer.active = false; timer.callback() }
    },
  }
}

function start(store: ReturnType<typeof createCompletionContinuationOutcomeStore>, sessionID: string, current = snapshot(["in_progress"])) {
  return store.start({
    sessionID,
    snapshot: current,
    inputTruncations: TRUNCATIONS,
    heuristicFacts: HEURISTIC,
    isContinuationCandidate: true,
    confidenceThreshold: 0.8,
  })
}

function observations(entries: readonly CompletionContinuationEntry[]) {
  return entries.filter((entry) => entry.kind === "observation")
}

describe("completion-continuation deferred outcome store", () => {
  test("keeps heuristic-first records until prediction and outcome both persist", () => {
    const entries: CompletionContinuationEntry[] = []
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry) } })
    const handle = start(store, "heuristic-first")
    expect(store.finalizeHeuristic(handle)).toBe(true)
    expect(store.resolvePrediction(handle, PREDICTION)).toBe(true)
    expect(entries).toHaveLength(0)
    store.markContinuationActivity(handle, { successful: true })
    store.start({ ...startInput("heuristic-first", snapshot(["completed"], "next")) })
    expect(observations(entries)[0]).toMatchObject({ heuristicFacts: HEURISTIC, predictionStatus: "filled", outcomeClosedBy: "tracked_work_complete" })
  })

  test("keeps prediction-first records until the heuristic and unchanged next idle terminalize", () => {
    const entries: CompletionContinuationEntry[] = []
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry) } })
    const handle = start(store, "prediction-first", snapshot(["in_progress"], "first", { total: 2, completed: 1, remaining: 1 }))
    expect(store.resolvePrediction(handle, PREDICTION)).toBe(true)
    expect(store.getRecord(handle)?.predictionStatus).toBe("filled")
    expect(entries).toHaveLength(0)
    store.markContinuationActivity(handle, { successful: true })
    store.observeNextIdle("prediction-first", snapshot(["in_progress"], "next", { total: 2, completed: 1, remaining: 1 }))
    expect(entries).toHaveLength(0)
    expect(store.finalizeHeuristic(handle)).toBe(true)
    expect(observations(entries)[0]).toMatchObject({ outcomeFacts: { actuallyComplete: false, progressing: false, stuck: true }, outcomeClosedBy: "unchanged_next_idle" })
    expect(store.resolvePrediction(handle, PREDICTION)).toBe(false)
    expect(store.finalizeHeuristic(handle)).toBe(false)
    expect(observations(entries)).toHaveLength(1)
  })

  test("keeps outcome-first records until prediction and heuristic terminalize", () => {
    const entries: CompletionContinuationEntry[] = []
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry) } })
    const handle = start(store, "outcome-first", snapshot(["completed"]))
    expect(store.getRecord(handle)?.outcomeClosedBy).toBe("tracked_work_complete")
    expect(entries).toHaveLength(0)
    store.resolvePrediction(handle, PREDICTION)
    store.finalizeHeuristic(handle)
    expect(observations(entries)[0]?.outcomeFacts).toEqual({ actuallyComplete: true, progressing: true, stuck: false })
  })

  test("does not label an expired window as stuck", async () => {
    const entries: CompletionContinuationEntry[] = []
    const clock = fakeClock()
    const store = createCompletionContinuationOutcomeStore({ clock: clock.clock, onEntry: (entry) => { entries.push(entry) } })
    const handle = start(store, "never-resolves")
    store.finalizeHeuristic(handle)
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([120_000])
    expect(clock.timers.every((timer) => timer.unrefCalls === 1)).toBe(true)
    clock.fire(0)
    expect(store.getRecord(handle)).toMatchObject({ outcomeStatus: "censored", outcomeClosedBy: "timeout", outcomeFacts: { stuck: "unknown" } })
    expect(entries).toHaveLength(0)
    await store.dispose()
    expect(observations(entries)[0]).toMatchObject({ predictionStatus: "timeout", outcomeStatus: "censored", outcomeClosedBy: "timeout", outcomeFacts: { stuck: "unknown" } })
    expect(observations(entries)).toHaveLength(1)
  })

  test("maps every mechanical progress signal and complete state exactly", () => {
    const incomplete = snapshot(["in_progress"], "a", { total: 2, completed: 1, remaining: 1 })
    const cases = [
      snapshot(["completed"], "b", { total: 2, completed: 1, remaining: 1 }),
      snapshot(["pending"], "b", { total: 2, completed: 1, remaining: 1 }),
      snapshot(["in_progress"], "b", { total: 2, completed: 2, remaining: 0 }),
    ]
    for (const next of cases) {
      expect(classifyCompletionContinuationOutcome({ current: incomplete, next, continuationActivity: true, successfulContinuation: true })).toMatchObject({ status: "observed", facts: { progressing: true, stuck: false } })
    }
    expect(classifyCompletionContinuationOutcome({ current: snapshot(["in_progress"], "a", { total: 1, completed: 1, remaining: 0 }), continuationActivity: false, successfulContinuation: false })).toMatchObject({ facts: { actuallyComplete: true, progressing: true, stuck: false } })
  })

  test.each([
    ["human", "human_intervention"],
    ["delete", "session_deleted"],
  ] as const)("censors %s without guessing stuck", async (mode, closedBy) => {
    const entries: CompletionContinuationEntry[] = []
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry) } })
    const handle = start(store, mode)
    store.resolvePrediction(handle, PREDICTION)
    store.finalizeHeuristic(handle)
    if (mode === "human") store.humanIntervention(mode)
    else await store.deleteSession(mode)
    if (mode === "delete") await store.deleteSession(mode)
    expect(observations(entries)[0]).toMatchObject({ outcomeStatus: "censored", outcomeClosedBy: closedBy, outcomeFacts: { stuck: "unknown" } })
  })

  test("resolves a predecessor from a new idle and starts a successor ordinal", () => {
    const entries: CompletionContinuationEntry[] = []
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry) } })
    const first = start(store, "resume", snapshot(["in_progress"], "first", { total: 2, completed: 1, remaining: 1 }))
    store.resolvePrediction(first, PREDICTION)
    store.finalizeHeuristic(first)
    store.markContinuationActivity(first, { successful: true })
    const second = start(store, "resume", snapshot(["in_progress"], "second", { total: 2, completed: 1, remaining: 1 }))
    expect([first.ordinal, second.ordinal]).toEqual([1, 2])
    expect(observations(entries)[0]?.outcomeClosedBy).toBe("unchanged_next_idle")
  })

  test("coalesces a duplicate idle without double-counting", () => {
    const store = createCompletionContinuationOutcomeStore()
    const current = snapshot(["in_progress"], "duplicate")
    const first = start(store, "duplicate", current)
    const second = start(store, "duplicate", current)
    expect(second).toEqual(first)
    expect(store.getCounters().starts).toBe(1)
    expect(store.getSessionRecords("duplicate")).toHaveLength(1)
  })

  test("evicts the real 257th session and 65th per-session record at the configured bounds", () => {
    const sessions = createCompletionContinuationOutcomeStore({ clock: fakeClock().clock })
    for (let index = 0; index < 256; index += 1) start(sessions, `session-${index}`, snapshot(["in_progress"], `${index}`))
    expect(sessions.inspect()).toMatchObject({ sessionCount: 256, recordCount: 256 })
    console.log("preEvictionSessions=256")
    start(sessions, "session-256", snapshot(["in_progress"], "256"))
    expect(sessions.inspect()).toMatchObject({ sessionCount: 256, recordsEvicted: 1 })

    const records = createCompletionContinuationOutcomeStore({ clock: fakeClock().clock })
    for (let index = 0; index < 64; index += 1) start(records, "record-cap", snapshot(["in_progress"], `${index}`))
    expect(records.getSessionRecords("record-cap")).toHaveLength(64)
    console.log("preEvictionRecordsPerSession=64")
    start(records, "record-cap", snapshot(["in_progress"], "64"))
    expect(records.getSessionRecords("record-cap")).toHaveLength(64)
    expect(records.inspect().recordsEvicted).toBe(1)
  })

  test("degrades missing snapshots and orphan next-idle events to unknown", () => {
    const store = createCompletionContinuationOutcomeStore()
    expect(store.observeNextIdle("orphan", {})).toBe(0)
    for (const next of [{ input: { boulder: null } }, { input: { todos: [] } }, {}]) {
      const handle = start(store, `malformed-${JSON.stringify(next)}`, snapshot(["in_progress"], "base", { total: 2, completed: 1, remaining: 1 }))
      store.markContinuationActivity(handle, { successful: true })
      expect(store.observeNextIdle(handle.sessionID, next)).toBe(0)
      expect(store.getRecord(handle)?.outcomeFacts).toEqual({ actuallyComplete: "unknown", progressing: "unknown", stuck: "unknown" })
    }
  })

  test("flushes censored observations and counters before an idempotent dispose clears maps", async () => {
    const entries: CompletionContinuationEntry[] = []
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const store = createCompletionContinuationOutcomeStore({ onEntry: (entry) => { entries.push(entry); return entry.kind === "observation" ? pending : undefined } })
    start(store, "dispose")
    const firstDispose = store.dispose()
    await Promise.resolve()
    expect(store.inspect().sessionCount).toBe(1)
    expect(entries.map((entry) => entry.kind)).toEqual(["observation", "counter_delta"])
    release?.()
    await firstDispose
    await store.dispose()
    expect(store.inspect().sessionCount).toBe(0)
    expect(observations(entries)).toHaveLength(1)
  })
})

function startInput(sessionID: string, current = snapshot(["in_progress"])) {
  return { sessionID, snapshot: current, inputTruncations: TRUNCATIONS, heuristicFacts: HEURISTIC, isContinuationCandidate: true, confidenceThreshold: 0.8 }
}
