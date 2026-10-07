import type {
  DecisionBackend,
  DecisionOutcome,
  DecisionRequest,
  Questions,
} from "@oh-my-opencode/jev-core"

import { createJevCompletionContinuation } from "../../features/jev/completion-continuation"
import type {
  JevCompletionContinuation,
  JevCompletionContinuationClock,
  JevCompletionContinuationSink,
} from "../../features/jev/completion-continuation"
import {
  BOULDER_UNAVAILABLE,
  drainAsync,
  enabledConfig,
  rawAnswerBackend,
} from "../../features/jev/completion-continuation.test-support"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { hasDefaultCompletionPromise } from "./completion-continuation-observer"
import { handleSessionIdle } from "./idle-event"
import type { ScheduleCompletionContinuationBoulderSnapshotInput } from "../../features/jev/completion-continuation-boulder-snapshot"
import { createSessionStateStore } from "./session-state"
import type { MessageWithInfo, Todo } from "./types"
import type { InertTraceEntry } from "./completion-continuation-inert-trace"

function unsafeTestValue<TValue extends PropertyKey>(value: TValue): TValue
function unsafeTestValue<TValue>(value: unknown): TValue
function unsafeTestValue<TValue>(value: unknown): TValue {
  return value as TValue
}

export type InertBackendMode = "success" | "sync-throw" | "rejection" | "timeout"

type ManualTimer = {
  readonly delayMs: number
  readonly callback: () => void
  active: boolean
}

class TraceClock implements JevCompletionContinuationClock {
  private current = 1_000_000
  private readonly timers: ManualTimer[] = []

  constructor(private readonly trace: InertTraceEntry[]) {}

  now = (): number => this.current

  schedule = (delayMs: number, callback: () => void) => {
    const timer: ManualTimer = { delayMs, callback, active: true }
    this.timers.push(timer)
    this.trace.push(["w2", delayMs === 2_500 ? "backend_call" : "outcome_timer", delayMs])
    return {
      cancel: () => { timer.active = false },
      unref: () => {},
    }
  }

  fire(delayMs: number): void {
    this.current += delayMs
    for (const timer of this.timers) {
      if (!timer.active || timer.delayMs !== delayMs) continue
      timer.active = false
      timer.callback()
    }
  }
}

class TraceSink implements JevCompletionContinuationSink {
  constructor(private readonly trace: InertTraceEntry[]) {
    trace.push(["w2", "sink_interval", "created"])
  }

  append = (entry: unknown): boolean => {
    this.trace.push(["w2", "file", JSON.stringify(entry)])
    return true
  }

  flushCounters = (): void => { this.trace.push(["w2", "counter", "flush"]) }
  dispose = (): void => { this.trace.push(["w2", "sink_interval", "disposed"]) }
}

class ManualMacrotasks {
  private readonly tasks: { readonly input: ScheduleCompletionContinuationBoulderSnapshotInput; active: boolean }[] = []

  constructor(private readonly trace: InertTraceEntry[]) {}

  schedule = (input: ScheduleCompletionContinuationBoulderSnapshotInput) => {
    const task = { input, active: true }
    this.tasks.push(task)
    this.trace.push(["w2", "macrotask", "scheduled"])
    return { cancel: () => { task.active = false } }
  }

  run(): void {
    for (const task of this.tasks.splice(0)) {
      if (!task.active) continue
      task.active = false
      task.input.onSnapshot(BOULDER_UNAVAILABLE)
    }
  }
}

function backend(mode: InertBackendMode, trace: InertTraceEntry[]): DecisionBackend {
  if (mode === "success") {
    return rawAnswerBackend(() => { trace.push(["w2", "backend_call", mode]) })
  }
  return {
    kind: "mock",
    decide<Q extends Questions>(_request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      trace.push(["w2", "backend_call", mode])
      if (mode === "sync-throw") throw new TypeError("synchronous backend failure")
      if (mode === "rejection") return Promise.reject(new TypeError("rejected backend failure"))
      return new Promise(() => undefined)
    },
  }
}

function observer(adapter: JevCompletionContinuation, trace: InertTraceEntry[], recordW2: boolean) {
  const recordOwned = (effect: string, payload?: unknown): void => {
    if (recordW2) trace.push(["w2", effect, payload])
  }
  return {
    observeEvent: (event: Parameters<JevCompletionContinuation["observeEvent"]>[0]) => {
      recordOwned("observeEvent", event.type); adapter.observeEvent(event)
    },
    recordPreInputSkip: (reason: Parameters<JevCompletionContinuation["recordPreInputSkip"]>[0]) => {
      recordOwned("recordPreInputSkip", reason); adapter.recordPreInputSkip(reason)
    },
    beginIdle: (input: Parameters<JevCompletionContinuation["beginIdle"]>[0]) => {
      recordOwned("beginIdle", input.sessionID); adapter.beginIdle(input)
    },
    finishHeuristic: (sessionID: string, facts: Parameters<JevCompletionContinuation["finishHeuristic"]>[1]) => {
      trace.push(["gauntlet", "semantic_branch", facts.gauntletOutcome])
      recordOwned("finishHeuristic", facts.gauntletOutcome)
      adapter.finishHeuristic(sessionID, facts)
    },
    markContinuationActivity: adapter.markContinuationActivity,
    humanIntervention: adapter.humanIntervention,
    deleteSession: adapter.deleteSession,
    dispose: () => { recordOwned("dispose"); void adapter.dispose() },
  }
}

type GauntletTimer = { readonly id: number; readonly callback: () => void; readonly delayMs: number; active: boolean }
type TimerInput = string | ((...args: unknown[]) => void)

export async function captureInertTrace(enabled: boolean, mode: InertBackendMode): Promise<readonly InertTraceEntry[]> {
  const trace: InertTraceEntry[] = []
  const timers: GauntletTimer[] = []
  const original = { now: Date.now, setTimeout, setInterval, clearTimeout, clearInterval }
  let nextTimerID = 41
  Date.now = () => 1_000_000
  globalThis.setTimeout = unsafeTestValue((callback: TimerInput, delay?: number) => {
    if (typeof callback !== "function") throw new TypeError("string timers are unsupported")
    if (delay !== 2_000) return original.setTimeout(callback, delay)
    const timer = { id: nextTimerID++, callback, delayMs: delay ?? 0, active: true }
    timers.push(timer)
    trace.push(["gauntlet", "setTimeout", `${timer.id}:${timer.delayMs}`])
    return timer.id
  })
  globalThis.setInterval = unsafeTestValue((callback: TimerInput, delay?: number) => {
    if (typeof callback !== "function") throw new TypeError("string timers are unsupported")
    if (delay !== 1_000) return original.setInterval(callback, delay)
    const timer = { id: nextTimerID++, callback, delayMs: delay ?? 0, active: true }
    timers.push(timer)
    trace.push(["gauntlet", "setInterval", `${timer.id}:${timer.delayMs}`])
    return timer.id
  })
  const clear = (effect: "clearTimeout" | "clearInterval", handle?: number): void => {
    const timer = timers.find((candidate) => candidate.id === handle)
    if (timer !== undefined) timer.active = false
    trace.push(["gauntlet", effect, handle ?? null])
  }
  globalThis.clearTimeout = unsafeTestValue((handle?: ReturnType<typeof setTimeout>) => {
    if (typeof handle === "number" && timers.some((timer) => timer.id === handle)) clear("clearTimeout", handle)
    else original.clearTimeout(handle)
  })
  globalThis.clearInterval = unsafeTestValue((handle?: ReturnType<typeof setInterval>) => {
    if (typeof handle === "number" && timers.some((timer) => timer.id === handle)) clear("clearInterval", handle)
    else original.clearInterval(handle)
  })

  const clock = new TraceClock(trace)
  const macrotasks = new ManualMacrotasks(trace)
  const adapter = enabled
    ? createJevCompletionContinuation({
      jevConfig: enabledConfig(), backend: backend(mode, trace), clock,
      scheduler: macrotasks.schedule, sink: new TraceSink(trace),
      logger: (message) => { trace.push(["w2", "log", message]) },
    })
    : createJevCompletionContinuation({ jevConfig: undefined })
  const messages = unsafeTestValue<MessageWithInfo[]>([{
    info: { role: "user", agent: "sisyphus", model: { providerID: "test", modelID: "test" } },
    parts: [{ type: "text", text: "continue the work" }],
  }])
  const todos: Todo[] = [{ id: "todo-1", content: "Finish todo 15", status: "pending", priority: "high" }]
  const stateStore = createSessionStateStore()
  const sessionID = `inert-${mode}`
  const event = { type: "session.idle", properties: { sessionID } }
  const beforeEvent = JSON.stringify(event)
  trace.push(["gauntlet", "state_before", JSON.stringify(stateStore.getState(sessionID))])
  trace.push(["gauntlet", "completion_detector", hasDefaultCompletionPromise(messages)])
  const ctx = unsafeTestValue<Parameters<typeof handleSessionIdle>[0]["ctx"]>({
    directory: "/tmp/jev-w2-inert",
    client: {
      session: {
        messages: async () => { trace.push(["gauntlet", "messages"]); return { data: messages } },
        todo: async () => { trace.push(["gauntlet", "todos"]); return { data: todos } },
        promptAsync: async (input: unknown) => { trace.push(["gauntlet", "prompt", JSON.stringify(input)]); return {} },
      },
      tui: { showToast: async (input: unknown) => { trace.push(["gauntlet", "toast", JSON.stringify(input)]); return {} } },
    },
  })

  try {
    const result = await handleSessionIdle({
      ctx, sessionID, sessionStateStore: stateStore,
      completionContinuationObserver: observer(adapter, trace, enabled),
    })
    trace.push(["gauntlet", "handler_return", JSON.stringify(result ?? null)])
    trace.push(["gauntlet", "event_mutation", `${beforeEvent}:${JSON.stringify(event)}`])
    const countdown = timers.find((timer) => timer.active && timer.delayMs === 2_000)
    countdown?.callback()
    await drainAsync(30)
    macrotasks.run()
    await drainAsync(30)
    if (mode === "timeout") { clock.fire(2_500); await drainAsync(30) }
    trace.push(["gauntlet", "state_after", JSON.stringify(stateStore.getExistingState(sessionID))])
    await adapter.dispose()
  } finally {
    stateStore.shutdown()
    releaseAllPromptAsyncReservationsForTesting()
    Date.now = original.now
    globalThis.setTimeout = original.setTimeout
    globalThis.setInterval = original.setInterval
    globalThis.clearTimeout = original.clearTimeout
    globalThis.clearInterval = original.clearInterval
  }
  return trace
}
