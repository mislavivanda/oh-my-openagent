/// <reference types="bun-types" />

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import type { DecisionRequest, DecisionState, Questions } from "@oh-my-opencode/jev-core"
import { readCompletionContinuationSink } from "./completion-continuation-reader"
import { createJevCompletionContinuation } from "./completion-continuation"
import {
  FILLED_RESULT,
  HEURISTIC_FACTS,
  ManualBoulderScheduler,
  ManualClock,
  MemorySink,
  completedTodo,
  drainAsync,
  enabledConfig,
  observationEntries,
  rawAnswerBackend,
  transcript,
} from "./completion-continuation.test-support"
import "./completion-continuation-adversarial.test"

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

describe("createJevCompletionContinuation", () => {
  test("#given either gate disabled #when exercised #then no backend, file, timer, listener, or observer state exists", async () => {
    for (const jevConfig of [
      enabledConfig(),
      { ...enabledConfig(), enabled: false },
    ]) {
      if (jevConfig.enabled) jevConfig.wires.completion_continuation.enabled = false
      const rootDir = join(tmpdir(), `jev-disabled-${crypto.randomUUID()}`)
      const scheduler = new ManualBoulderScheduler()
      const sink = new MemorySink()
      let backendCalls = 0
      const adapter = createJevCompletionContinuation({
        jevConfig, rootDir, scheduler: scheduler.schedule, sink,
        backend: rawAnswerBackend(() => { backendCalls += 1 }),
      })

      adapter.observeEvent({ type: "session.diff", properties: { sessionID: "s", diff: [] } })
      const started = adapter.beginIdle({ sessionID: "s", directory: "/tmp", todos: completedTodo(), transcript: transcript(), isContinuationCandidate: true })
      await adapter.dispose()

      expect(started).toBe(false)
      expect(adapter.enabled).toBe(false)
      expect(backendCalls).toBe(0)
      expect(scheduler.pending).toHaveLength(0)
      expect(sink.entries).toHaveLength(0)
      expect(sink.disposals).toBe(0)
      expect(existsSync(rootDir)).toBe(false)
      expect(adapter.inspect()).toEqual({ inFlight: 0, dispatchesDropped: 0, pendingDecisions: 0, diffSessions: 0 })
    }
  })

  test("#given each configured backend #when scheduling #then selectDecisionBackend supplies the requested kind", async () => {
    const kinds: string[] = []
    for (const kind of ["real", "mock", "llm-adapter"] as const) {
      const scheduler = new ManualBoulderScheduler()
      const adapter = createJevCompletionContinuation({
        jevConfig: enabledConfig(kind), env: {}, scheduler: scheduler.schedule,
        sink: new MemorySink(), clock: new ManualClock(),
        dispatcher: async ({ backend }) => { kinds.push(backend.kind); return FILLED_RESULT },
      })
      beginCompleted(adapter, kind)
      scheduler.runAll()
      await drainAsync()
      await adapter.dispose()
    }
    expect(kinds).toEqual(["real", "mock", "llm-adapter"])
  })

  test("#given a custom base URL #when the real backend sends #then only that environment value changes the origin", async () => {
    const customOrigin = "http://127.0.0.1:43199"
    const origins: string[] = []
    const run = async (baseURL: string | undefined): Promise<void> => {
      const scheduler = new ManualBoulderScheduler()
      const adapter = createJevCompletionContinuation({
        jevConfig: enabledConfig("real"),
        env: { TYPESAFE_API_KEY: "test-key", OMO_JEV_BASE_URL: baseURL },
        scheduler: scheduler.schedule, sink: new MemorySink(), clock: new ManualClock(),
        fetch: async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input)
          origins.push(new URL(url).origin)
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        },
      })
      beginCompleted(adapter)
      scheduler.runAll()
      await drainAsync(20)
      await adapter.dispose()
    }
    await run(customOrigin)
    await run(undefined)
    expect(origins[0]).toBe(customOrigin)
    expect(origins[1]).not.toBe(customOrigin)
  })

  test("#given one decision #when dispatched #then one backend call contains all three questions", async () => {
    const scheduler = new ManualBoulderScheduler()
    const requests: DecisionRequest<Questions>[] = []
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule,
      sink: new MemorySink(), clock: new ManualClock(),
      backend: rawAnswerBackend((request) => requests.push(request)),
    })
    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()

    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["actually_complete", "progressing", "stuck"])
    await adapter.dispose()
  })

  test("drops above max_inflight and persists the drop counter", async () => {
    const attemptedStarts = 20
    const cap = 8
    const rootDir = join(tmpdir(), `jev-inflight-${crypto.randomUUID()}`)
    const scheduler = new ManualBoulderScheduler()
    const clock = new ManualClock()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig("mock", cap), rootDir,
      scheduler: scheduler.schedule, clock,
      dispatcher: () => new Promise(() => undefined),
    })
    for (let index = 0; index < attemptedStarts; index += 1) {
      beginCompleted(adapter, `session-${index}`)
    }
    try {
      scheduler.runAll()
      await drainAsync()
      const persisted = [...readCompletionContinuationSink(rootDir).latestCountersByProcess.values()]
        .reduce((sum, entry) => sum + entry.counters.dispatchesDropped, 0)

      console.log(`ATTEMPTED_STARTS=${attemptedStarts} MAX_INFLIGHT=${cap} IN_FLIGHT=${adapter.inspect().inFlight} PERSISTED_DROPS=${persisted}`)
      expect(adapter.inspect().inFlight).toBe(cap)
      expect(adapter.inspect().dispatchesDropped).toBe(attemptedStarts - cap)
      expect(persisted).toBe(attemptedStarts - cap)
    } finally {
      clock.fire(2_500)
      await drainAsync()
      await adapter.dispose()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("#given mutable caller data #when mutated immediately #then snapshot is stable and caller runs before state building", async () => {
    const order: string[] = []
    const scheduler = new ManualBoulderScheduler()
    const todos = [{ id: "todo-1", status: "completed", content: "original todo" }]
    const messages = [{ role: "assistant", content: "original transcript", synthetic: false }]
    let state: DecisionState | undefined
    const backend = rawAnswerBackend((request) => { order.push("state-built"); state = request.state })
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule,
      sink: new MemorySink(), clock: new ManualClock(), backend,
    })

    adapter.beginIdle({ sessionID: "mutable", directory: "/tmp", todos, transcript: messages, isContinuationCandidate: true })
    adapter.finishHeuristic("mutable", HEURISTIC_FACTS)
    todos[0] = { id: "changed", status: "pending", content: "mutated todo" }
    messages[0] = { role: "user", content: "mutated transcript", synthetic: false }
    order.push("caller-continued")
    expect(state).toBeUndefined()
    scheduler.runAll()
    await drainAsync()

    expect(order).toEqual(["caller-continued", "state-built"])
    expect(JSON.stringify(state)).toContain("original todo")
    expect(JSON.stringify(state)).toContain("original transcript")
    expect(JSON.stringify(state)).not.toContain("mutated")
    await adapter.dispose()
  })

  test("#given a filled result #when observation closes #then it is recorded without actionable output", async () => {
    const scheduler = new ManualBoulderScheduler()
    const sink = new MemorySink()
    const adapter = createJevCompletionContinuation({
      jevConfig: enabledConfig(), scheduler: scheduler.schedule, sink,
      clock: new ManualClock(), dispatcher: async () => FILLED_RESULT,
    })
    beginCompleted(adapter)
    scheduler.runAll()
    await drainAsync()
    const observation = observationEntries(sink)[0]
    expect(observation).toMatchObject({ predictionStatus: "filled", outcomeStatus: "observed" })
    expect("apply" in adapter || "recommendation" in adapter || "decision" in adapter).toBe(false)
    await adapter.dispose()
  })
})
