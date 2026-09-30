import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spyOn } from "bun:test"
import type { DecisionBackend, DecisionOutcome, DecisionRequest, Questions } from "@oh-my-opencode/jev-core"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { JevConfigSchema } from "../../config/schema/jev"
import * as logger from "../../shared/logger"
import { NOOP_COMPLETION_CONTINUATION_OBSERVER } from "../../hooks/todo-continuation-enforcer"
import { handleSessionIdle } from "../../hooks/todo-continuation-enforcer/idle-event"
import { createSessionStateStore } from "../../hooks/todo-continuation-enforcer/session-state"
import type { MessageWithInfo, Todo } from "../../hooks/todo-continuation-enforcer/types"
import { createJevCompletionContinuation } from "./completion-continuation"
import { readCompletionContinuationSink } from "./completion-continuation-reader"
import {
  BOULDER_UNAVAILABLE,
  HEURISTIC_FACTS,
  ManualBoulderScheduler,
  MemorySink,
  drainAsync,
} from "./completion-continuation.test-support"
import {
  AuditedClock,
  assertW2HandleAudit,
  installSinkIntervalAudit,
  percentile99,
  unrefMissing,
} from "./completion-continuation-runtime-audit"

const BACKEND_TIMEOUT_MS = 100
const OUTCOME_WINDOW_MS = 1_000
const MAX_INFLIGHT = 8

export type RuntimeMeasurements = {
  readonly activeHandles: number
  readonly unrefMissing: number
  readonly inFlightMax: number
  readonly attemptedExcess: number
  readonly persistedDrops: number
  readonly heapDeltaBytes: number
}

function stressConfig() {
  return JevConfigSchema.parse({
    enabled: true,
    backend: "mock",
    model: "jev-w2-runtime",
    wires: { completion_continuation: {
      enabled: true,
      timeout_ms: BACKEND_TIMEOUT_MS,
      outcome_window_ms: OUTCOME_WINDOW_MS,
      max_inflight: MAX_INFLIGHT,
    } },
  })
}

function hangingBackend(onStart?: () => void): DecisionBackend {
  return {
    kind: "mock",
    decide<Q extends Questions>(_request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      onStart?.()
      return new Promise(() => undefined)
    },
  }
}

export async function runOneSessionStress(turns = 1_000): Promise<RuntimeMeasurements> {
  const rootDir = await mkdtemp(join(tmpdir(), "jev-w2-runtime-"))
  const interval = installSinkIntervalAudit()
  const clock = new AuditedClock(BACKEND_TIMEOUT_MS)
  const scheduler = new ManualBoulderScheduler()
  let inFlightMax = 0
  Bun.gc(true)
  const heapBefore = process.memoryUsage().heapUsed
  const adapter = createJevCompletionContinuation({
    jevConfig: stressConfig(), rootDir, clock,
    scheduler: scheduler.schedule,
    backend: hangingBackend(),
    logger: () => {},
  })
  try {
    for (let turn = 0; turn < turns; turn += 1) {
      const sessionID = "one-session-stress"
      adapter.beginIdle({
        sessionID,
        directory: rootDir,
        todos: [{ id: "todo-stable", status: "in_progress", content: "x".repeat(256) }],
        transcript: [{ role: "assistant", content: `turn-${turn}`, synthetic: false }],
        isContinuationCandidate: true,
      })
      adapter.finishHeuristic(sessionID, HEURISTIC_FACTS)
      scheduler.runAll(BOULDER_UNAVAILABLE)
      inFlightMax = Math.max(inFlightMax, adapter.inspect().inFlight)
    }
    await drainAsync(40)
    inFlightMax = Math.max(inFlightMax, adapter.inspect().inFlight)
    const auditedHandles = [...clock.handles, interval.handle]
    const activeHandles = auditedHandles.filter((handle) => handle.active).length
    assertW2HandleAudit(auditedHandles)
    const attemptedExcess = turns - MAX_INFLIGHT
    const persistedDrops = [...readCompletionContinuationSink(rootDir).latestCountersByProcess.values()]
      .reduce((sum, entry) => sum + entry.counters.dispatchesDropped, 0)

    clock.fireCategory("outcome")
    await drainAsync(40)
    Bun.gc(true)
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
    await adapter.dispose()
    await adapter.dispose()
    return {
      activeHandles,
      unrefMissing: unrefMissing(auditedHandles),
      inFlightMax,
      attemptedExcess,
      persistedDrops,
      heapDeltaBytes,
    }
  } finally {
    await adapter.dispose()
    interval.restore()
    await rm(rootDir, { recursive: true, force: true })
  }
}

function maxSizeInput(): { readonly todos: readonly Todo[]; readonly transcript: readonly MessageWithInfo[] } {
  return {
    todos: Array.from({ length: 32 }, (_, index) => ({
      id: `todo-${index}`, status: "in_progress", content: "x".repeat(256), priority: "high",
    })),
    transcript: Array.from({ length: 8 }, (_, index) => ({
      info: { role: index % 2 === 0 ? "user" : "assistant", agent: "sisyphus" },
      parts: [{ type: "text", text: "y".repeat(1_500) }],
    })),
  }
}

export async function measureSynchronousSeamP99(): Promise<number> {
  const input = maxSizeInput()
  const adapter = createJevCompletionContinuation({
    jevConfig: stressConfig(), sink: new MemorySink(),
    clock: new AuditedClock(BACKEND_TIMEOUT_MS), backend: hangingBackend(),
    scheduler: () => ({ cancel: () => {} }), logger: () => {},
  })
  const samples: number[] = []
  for (let sample = 0; sample < 200; sample += 1) {
    const startedAt = performance.now()
    adapter.beginIdle({
      sessionID: `sync-${sample}`, directory: "/tmp",
      todos: input.todos, transcript: input.transcript, isContinuationCandidate: true,
    })
    samples.push(performance.now() - startedAt)
  }
  await adapter.dispose()
  return percentile99(samples)
}

export async function measureAddedIdleHandlerP99(): Promise<number> {
  const input = maxSizeInput()
  const scheduler = new ManualBoulderScheduler()
  const adapter = createJevCompletionContinuation({
    jevConfig: stressConfig(), sink: new MemorySink(),
    clock: new AuditedClock(BACKEND_TIMEOUT_MS), backend: hangingBackend(),
    scheduler: scheduler.schedule, logger: () => {},
  })
  const enabledObserver = {
    ...NOOP_COMPLETION_CONTINUATION_OBSERVER,
    beginIdle: adapter.beginIdle,
    finishHeuristic: adapter.finishHeuristic,
  }
  const enabledStore = createSessionStateStore()
  const disabledStore = createSessionStateStore()
  const ctx = unsafeTestValue<Parameters<typeof handleSessionIdle>[0]["ctx"]>({
    directory: "/tmp/jev-w2-idle-perf",
    client: { session: {
      messages: async () => ({ data: input.transcript }),
      todo: async () => ({ data: input.todos }),
    } },
  })
  const samples: number[] = []
  const logSpy = spyOn(logger, "log").mockImplementation(() => {})
  try {
    for (let sample = 0; sample < 200; sample += 1) {
      const sessionID = `idle-${sample}`
      disabledStore.getState(sessionID).inFlight = true
      const baselineAt = performance.now()
      await handleSessionIdle({ ctx, sessionID, sessionStateStore: disabledStore })
      const baselineMs = performance.now() - baselineAt
      enabledStore.getState(sessionID).inFlight = true
      const enabledAt = performance.now()
      await handleSessionIdle({ ctx, sessionID, sessionStateStore: enabledStore, completionContinuationObserver: enabledObserver })
      samples.push(Math.max(0, performance.now() - enabledAt - baselineMs))
    }
  } finally {
    logSpy.mockRestore()
    enabledStore.shutdown()
    disabledStore.shutdown()
    await adapter.dispose()
  }
  return percentile99(samples)
}

export async function removedUnrefFailure(): Promise<string> {
  const clock = new AuditedClock(BACKEND_TIMEOUT_MS, true)
  const scheduler = new ManualBoulderScheduler()
  const adapter = createJevCompletionContinuation({
    jevConfig: stressConfig(), sink: new MemorySink(), clock,
    scheduler: scheduler.schedule, backend: hangingBackend(), logger: () => {},
  })
  adapter.beginIdle({ sessionID: "unref-negative", directory: "/tmp", todos: [{ id: "todo", status: "in_progress", content: "work" }], transcript: [], isContinuationCandidate: true })
  adapter.finishHeuristic("unref-negative", HEURISTIC_FACTS)
  scheduler.runAll()
  await drainAsync()
  try {
    assertW2HandleAudit(clock.handles)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    await adapter.dispose()
    return error.message
  }
  await adapter.dispose()
  throw new TypeError("removed unref did not fail the handle audit")
}
