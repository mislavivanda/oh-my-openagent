/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { DecisionBackend, DecisionOutcome, Questions } from "@oh-my-opencode/jev-core"
import {
  createJevCompletionContinuation,
  type JevCompletionContinuationDispatcher,
} from "./completion-continuation"
import {
  FILLED_RESULT,
  HEURISTIC_FACTS,
  ManualBoulderScheduler,
  ManualClock,
  MemorySink,
  completedTodo,
  drainAsync,
  enabledConfig,
  incompleteTodo,
  observationEntries,
  rawAnswerBackend,
  transcript,
} from "./completion-continuation.test-support"

function beginCompleted(
  adapter: ReturnType<typeof createJevCompletionContinuation>,
  sessionID = "session-1",
): void {
  adapter.beginIdle({
    sessionID,
    directory: "/tmp",
    todos: completedTodo(),
    transcript: transcript(),
    isContinuationCandidate: true,
  })
  adapter.finishHeuristic(sessionID, HEURISTIC_FACTS)
}

describe("createJevCompletionContinuation failures", () => {
  test("#given no API key #when the real backend runs #then missing-key failure is recorded", async () => {
    const scheduler = new ManualBoulderScheduler()
    const sink = new MemorySink()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig("real"),
      env: {},
      scheduler: scheduler.schedule,
      sink,
      clock: new ManualClock(),
    })

    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()

    expect(observationEntries(sink)[0]).toMatchObject({
      predictionStatus: "failed",
      unavailableReason: "missing_api_key",
    })
    await adapter.dispose()
  })

  const dispatchFailures: readonly (readonly [string, JevCompletionContinuationDispatcher])[] = [
    ["throws", () => { throw new TypeError("sync failure") }],
    ["rejects", () => Promise.reject(new TypeError("async failure"))],
  ]

  test.each(dispatchFailures)("#given a dispatcher that %s #when the decision runs #then transport failure is contained", async (_name, dispatcher) => {
    const scheduler = new ManualBoulderScheduler()
    const sink = new MemorySink()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink,
      clock: new ManualClock(), dispatcher,
    })

    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()

    expect(observationEntries(sink)[0]).toMatchObject({
      predictionStatus: "failed", unavailableReason: "transport_error",
    })
    expect(adapter.inspect().inFlight).toBe(0)
    await adapter.dispose()
  })

  test("#given a backend that never resolves #when the injected clock fires #then timeout frees the slot", async () => {
    const scheduler = new ManualBoulderScheduler()
    const clock = new ManualClock()
    const sink = new MemorySink()
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        return new Promise(() => undefined)
      },
    }
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink, clock, backend,
    })

    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()
    expect(adapter.inspect().inFlight).toBe(1)
    clock.fire(2_500)
    await drainAsync()

    expect(adapter.inspect().inFlight).toBe(0)
    expect(clock.timers.every((timer) => timer.unrefed)).toBe(true)
    expect(observationEntries(sink)[0]).toMatchObject({
      predictionStatus: "timeout", unavailableReason: "timeout",
    })
    await adapter.dispose()
  })

  test("#given a malformed answer and throwing sink #when work settles #then neither failure escapes", async () => {
    const scheduler = new ManualBoulderScheduler()
    const sink = new MemorySink()
    const malformed: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        return JSON.parse(JSON.stringify({
          status: "decided", answers: {}, model: "bad", latencyMs: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        }))
      },
    }
    const logs: string[] = []
    sink.throwOnAppend = true
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink,
      clock: new ManualClock(), backend: malformed,
      logger: (message) => logs.push(message),
    })

    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()

    expect(logs.some((message) => message.includes("failed"))).toBe(true)
    expect(adapter.inspect().inFlight).toBe(0)
    expect(await adapter.dispose()).toBeUndefined()
  })

  test("#given rejection and a throwing logger #when dispatched #then no unhandled rejection fires", async () => {
    const scheduler = new ManualBoulderScheduler()
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const adapter = createJevCompletionContinuation({
        jevConfig: enabledConfig(), scheduler: scheduler.schedule,
        sink: new MemorySink(), clock: new ManualClock(),
        dispatcher: () => Promise.reject(new TypeError("rejected")),
        logger: () => { throw new TypeError("logger failed") },
      })
      beginCompleted(adapter)
      scheduler.runAll()
      await drainAsync()
      await adapter.dispose()
      await drainAsync()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", listener)
    }
  })

  test("#given dispose during in-flight work #when interrupted twice and restarted #then writes stop and counters remain", async () => {
    const scheduler = new ManualBoulderScheduler()
    const clock = new ManualClock()
    const sink = new MemorySink()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink, clock,
      dispatcher: () => new Promise(() => undefined),
    })
    adapter.beginIdle({ sessionID: "interrupted", directory: "/tmp", todos: incompleteTodo(), transcript: transcript(), isContinuationCandidate: true })
    adapter.finishHeuristic("interrupted", HEURISTIC_FACTS)
    scheduler.runAll()
    await drainAsync()

    await adapter.dispose()
    await adapter.dispose()
    const entriesAfterDispose = sink.entries.length
    const counters = adapter.getCounters()
    const startedAfterDispose = adapter.beginIdle({ sessionID: "late", directory: "/tmp", todos: completedTodo(), transcript: transcript(), isContinuationCandidate: true })
    clock.fire(2_500)
    await drainAsync()

    expect(startedAfterDispose).toBe(false)
    expect(sink.entries).toHaveLength(entriesAfterDispose)
    expect(counters).toMatchObject({ starts: 1, censoredWindows: 1 })
    expect(adapter.inspect()).toMatchObject({ inFlight: 0, pendingDecisions: 0 })
    expect(sink.disposals).toBe(1)
  })

  test("#given a valid backend #when one completed decision runs #then the helper remains valid", async () => {
    const scheduler = new ManualBoulderScheduler()
    const sink = new MemorySink()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink,
      clock: new ManualClock(), backend: rawAnswerBackend(),
    })
    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()
    expect(observationEntries(sink)[0]?.predictionStatus).toBe(FILLED_RESULT.predictionStatus)
    await adapter.dispose()
  })
})
