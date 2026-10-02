/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  buildCompletionContinuationTodoStatusDigest,
  type CompletionContinuationState,
} from "@oh-my-opencode/jev-core"
import { createCompletionContinuationDiffCache } from "./completion-continuation-diff-cache"
import { createCompletionContinuationDispatchController } from "./completion-continuation-dispatch"
import { captureCompletionContinuationInput } from "./completion-continuation-input"
import { createCompletionContinuationOutcomeStore } from "./completion-continuation-outcome-store"
import { createJevCompletionContinuation } from "./completion-continuation"
import {
  FILLED_RESULT,
  HEURISTIC_FACTS,
  ManualBoulderScheduler,
  ManualClock,
  MemorySink,
  drainAsync,
  enabledConfig,
  incompleteTodo,
  rawAnswerBackend,
  transcript,
} from "./completion-continuation.test-support"

const FIRST_BOULDER = {
  input: { total: 3, completed: 1, remaining: 2, nextTaskTitle: "Run regression tests" },
  availability: { status: "available", reason: null },
  capturedAt: 10,
  digest: "sha256:first-boulder",
  titleTruncated: false,
} as const

const SECOND_BOULDER = {
  input: { total: 3, completed: 2, remaining: 1, nextTaskTitle: "Review results" },
  availability: { status: "available", reason: null },
  capturedAt: 20,
  digest: "sha256:second-boulder",
  titleTruncated: false,
} as const

function startOutcome(
  store: ReturnType<typeof createCompletionContinuationOutcomeStore>,
  sessionID: string,
  content: string,
) {
  const snapshot = captureCompletionContinuationInput({
    todos: incompleteTodo(content),
    transcript: transcript(content),
    diff: null,
    now: () => 1,
  })
  const handle = store.start({
    sessionID,
    snapshot,
    inputTruncations: {
      todoItems: false,
      todoContent: false,
      transcriptMessages: false,
      transcriptContent: false,
      diffPaths: false,
      diffContent: false,
      boulderContent: false,
      state: false,
    },
    heuristicFacts: HEURISTIC_FACTS,
    isContinuationCandidate: true,
    confidenceThreshold: 0.8,
  })
  return { handle, snapshot }
}

async function captureStateWithStore(
  outcomes: ReturnType<typeof createCompletionContinuationOutcomeStore>,
): Promise<CompletionContinuationState | undefined> {
  const scheduler = new ManualBoulderScheduler()
  const clock = new ManualClock()
  let captured: CompletionContinuationState | undefined
  const config = enabledConfig()
  const controller = createCompletionContinuationDispatchController({
    backend: rawAnswerBackend(),
    dispatcher: async ({ state }) => { captured = state; return FILLED_RESULT },
    outcomes,
    diffCache: createCompletionContinuationDiffCache({ now: clock.now }),
    clock,
    scheduler: scheduler.schedule,
    wireConfig: config.wires.completion_continuation,
    model: config.model,
    safeLog: () => {},
    safeFlushCounters: () => {},
  })
  expect(controller.beginIdle({
    sessionID: "degraded",
    directory: "/tmp",
    todos: incompleteTodo(),
    transcript: transcript(),
    isContinuationCandidate: true,
  })).toBeTrue()
  controller.finishHeuristic("degraded", HEURISTIC_FACTS)
  scheduler.runAll()
  await drainAsync()
  await controller.dispose()
  return captured
}

describe("completion-continuation previous idle state", () => {
  test("#given multiple real records #when latest predecessor is read #then highest ordinal is returned without store mutation", () => {
    const store = createCompletionContinuationOutcomeStore()
    const first = startOutcome(store, "ordered", "first")
    store.markContinuationActivity(first.handle, { successful: true })
    const second = startOutcome(store, "ordered", "second")
    const inspection = store.inspect()

    const latest = store.getLatestPreviousSnapshot("ordered")

    expect(latest).toEqual({ snapshot: second.snapshot, continuationDispatched: false })
    expect(store.inspect()).toEqual(inspection)
  })

  test("#given two idles in one session #when the second decision is built #then it carries the first idle digests counts and dispatch status", async () => {
    const scheduler = new ManualBoulderScheduler()
    const states: CompletionContinuationState[] = []
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(),
      scheduler: scheduler.schedule,
      sink: new MemorySink(),
      clock: new ManualClock(),
      dispatcher: async ({ state }) => { states.push(state); return FILLED_RESULT },
    })

    adapter.beginIdle({
      sessionID: "two-idles",
      directory: "/tmp",
      todos: incompleteTodo("Implement parser"),
      transcript: transcript("Implementation started"),
      isContinuationCandidate: true,
    })
    adapter.finishHeuristic("two-idles", HEURISTIC_FACTS)
    scheduler.runAll(FIRST_BOULDER)
    await drainAsync()
    adapter.markContinuationActivity("two-idles", true)
    adapter.beginIdle({
      sessionID: "two-idles",
      directory: "/tmp",
      todos: [
        { id: "todo-1", status: "completed", content: "Implement parser" },
        { id: "todo-2", status: "in_progress", content: "Add regression tests" },
      ],
      transcript: transcript("Parser implemented; tests remain"),
      isContinuationCandidate: true,
    })
    adapter.finishHeuristic("two-idles", HEURISTIC_FACTS)
    scheduler.runAll(SECOND_BOULDER)
    await drainAsync()

    expect(states[0]).toMatchObject({ previous: { available: false, reason: "first_idle" } })
    expect(states[1]).toMatchObject({
      previous: {
        available: true,
        todoStatusDigest: buildCompletionContinuationTodoStatusDigest(incompleteTodo("Implement parser")),
        boulderDigest: FIRST_BOULDER.digest,
        todo: { total: 1, completed: 0 },
        boulder: { total: 3, completed: 1, remaining: 2 },
        continuationDispatched: true,
      },
    })
    await adapter.dispose()
  })

  test("#given a missing latest accessor #when idle begins #then state degrades to first idle without throwing", async () => {
    const store = createCompletionContinuationOutcomeStore()
    Reflect.deleteProperty(store, "getLatestPreviousSnapshot")

    const state = await captureStateWithStore(store)

    expect(state).toMatchObject({ previous: { available: false, reason: "first_idle" } })
  })

  test("#given a throwing latest accessor #when idle begins #then state degrades to first idle without throwing", async () => {
    const store = createCompletionContinuationOutcomeStore()
    let reads = 0
    Object.defineProperty(store, "getLatestPreviousSnapshot", {
      value: () => {
        reads += 1
        throw new TypeError("read failed")
      },
    })

    const state = await captureStateWithStore(store)

    expect(reads).toBe(1)
    expect(state).toMatchObject({ previous: { available: false, reason: "first_idle" } })
  })
})
