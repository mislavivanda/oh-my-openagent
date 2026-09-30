/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from "bun:test"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import * as logger from "../../shared/logger"
import { createTodoContinuationEnforcer } from "."

type ObserverMethod =
  | "observeEvent"
  | "recordPreInputSkip"
  | "beginIdle"
  | "finishHeuristic"
  | "markContinuationActivity"
  | "humanIntervention"
  | "deleteSession"
  | "dispose"

type ObserverCall = {
  readonly receiver: object
  readonly method: ObserverMethod
  readonly args: readonly unknown[]
}

type OwnedTrace = readonly [owner: "gauntlet" | "w2", effect: string, payload?: unknown]

function createObserver(calls: ObserverCall[], trace?: OwnedTrace[], throws = false): object {
  const observer: Record<ObserverMethod, (...args: unknown[]) => void> = {
    observeEvent: (...args) => record("observeEvent", args),
    recordPreInputSkip: (...args) => record("recordPreInputSkip", args),
    beginIdle: (...args) => record("beginIdle", args),
    finishHeuristic: (...args) => record("finishHeuristic", args),
    markContinuationActivity: (...args) => record("markContinuationActivity", args),
    humanIntervention: (...args) => record("humanIntervention", args),
    deleteSession: (...args) => record("deleteSession", args),
    dispose: (...args) => record("dispose", args),
  }
  function record(method: ObserverMethod, args: readonly unknown[]): void {
    calls.push({ receiver: observer, method, args })
    trace?.push(["w2", method])
    if (throws) throw new TypeError(`observer ${method} failed`)
  }
  return observer
}

async function runContinuationTrace(observer: object): Promise<OwnedTrace[]> {
  const trace: OwnedTrace[] = []
  const original = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  }
  let timerID = 40
  const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
    if (message.includes("Completion-continuation observer failed")) trace.push(["w2", "log", message])
  })
  globalThis.setTimeout = unsafeTestValue((_callback: TimerHandler, delay?: number) => {
    trace.push(["gauntlet", "setTimeout", delay])
    return timerID++
  })
  globalThis.setInterval = unsafeTestValue((_callback: TimerHandler, delay?: number) => {
    trace.push(["gauntlet", "setInterval", delay])
    return timerID++
  })
  globalThis.clearTimeout = unsafeTestValue((handle?: number) => {
    trace.push(["gauntlet", "clearTimeout", handle])
  })
  globalThis.clearInterval = unsafeTestValue((handle?: number) => {
    trace.push(["gauntlet", "clearInterval", handle])
  })
  const ctx = unsafeTestValue<Parameters<typeof createTodoContinuationEnforcer>[0]>({
    directory: "/tmp/observer-wiring",
    client: {
      session: {
        messages: async () => {
          trace.push(["gauntlet", "messages"])
          return { data: [{ info: { role: "user", agent: "sisyphus" }, parts: [{ type: "text", text: "work" }] }] }
        },
        todo: async () => {
          trace.push(["gauntlet", "todos"])
          return { data: [{ id: "todo-1", content: "Finish", status: "pending", priority: "high" }] }
        },
      },
      tui: { showToast: async (input: unknown) => { trace.push(["gauntlet", "toast", input]); return {} } },
    },
  })
  const enforcer = createTodoContinuationEnforcer(ctx, unsafeTestValue({ completionContinuationObserver: observer }))
  try {
    enforcer.markRecovering("pre-input")
    await enforcer.handler({ event: { type: "session.idle", properties: { sessionID: "pre-input" } } })
    await enforcer.handler({ event: { type: "session.diff", properties: { sessionID: "live", diff: [] } } })
    await enforcer.handler({ event: { type: "session.idle", properties: { sessionID: "live" } } })
    await enforcer.handler({ event: { type: "message.updated", properties: { info: { id: "assistant-1", sessionID: "live", role: "assistant" } } } })
    await enforcer.handler({ event: { type: "session.idle", properties: { sessionID: "live" } } })
    await enforcer.handler({ event: { type: "session.idle", properties: { sessionID: "live" } } })
    await enforcer.handler({ event: { type: "message.updated", properties: { info: { id: "user-1", sessionID: "live", role: "user" }, parts: [{ type: "text", text: "pause" }] } } })
    await enforcer.handler({ event: { type: "session.deleted", properties: { sessionID: "live" } } })
  } finally {
    enforcer.dispose()
    logSpy.mockRestore()
    globalThis.setTimeout = original.setTimeout
    globalThis.setInterval = original.setInterval
    globalThis.clearTimeout = original.clearTimeout
    globalThis.clearInterval = original.clearInterval
  }
  return trace
}

function gauntletTrace(trace: readonly OwnedTrace[]): readonly OwnedTrace[] {
  return trace.filter(([owner]) => owner === "gauntlet")
}

describe("completion-continuation observer wiring", () => {
  test("shares one observer across diff, idle, activity, intervention, delete, and dispose", async () => {
    // given
    const calls: ObserverCall[] = []
    const observer = createObserver(calls)

    // when
    await runContinuationTrace(observer)

    // then
    expect(calls.length).toBeGreaterThan(8)
    expect(calls.every(({ receiver }) => receiver === observer)).toBe(true)
    expect(new Set(calls.map(({ method }) => method))).toEqual(new Set<ObserverMethod>([
      "observeEvent", "recordPreInputSkip", "beginIdle", "finishHeuristic",
      "markContinuationActivity", "humanIntervention", "deleteSession", "dispose",
    ]))
  })

  test("keeps continuation behavior when the W2 observer throws", async () => {
    // given
    const noOpCalls: ObserverCall[] = []
    const throwingCalls: ObserverCall[] = []

    // when
    const baseline = gauntletTrace(await runContinuationTrace(createObserver(noOpCalls)))
    const throwing = gauntletTrace(await runContinuationTrace(createObserver(throwingCalls, undefined, true)))

    // then
    expect(throwingCalls.map(({ method }) => method)).toEqual(noOpCalls.map(({ method }) => method))
    expect(JSON.stringify(throwing)).toBe(JSON.stringify(baseline))
  })

  test("filters only owned W2 effects and detects a pre-existing trace perturbation", async () => {
    // given
    const calls: ObserverCall[] = []
    const owned: OwnedTrace[] = []
    const observer = createObserver(calls, owned)
    const runtimeEffects = [
      "macrotask", "outcome_timer", "sink_interval", "backend_call", "log", "counter", "file",
    ] as const

    // when
    const existing = await runContinuationTrace(observer)
    const combined = [
      ...existing,
      ...owned,
      ...runtimeEffects.map((effect): OwnedTrace => ["w2", effect]),
    ]
    const filtered = gauntletTrace(combined)
    const removed = combined.filter(([owner]) => owner === "w2").map(([, effect]) => effect)
    const perturbed = filtered.map((entry) => entry[1] === "setTimeout" ? [entry[0], entry[1], 2001] as const : entry)

    // then
    expect(filtered.length).toBeGreaterThan(4)
    expect(filtered.map(([, effect]) => effect)).toEqual(expect.arrayContaining(["messages", "todos", "toast", "setInterval", "setTimeout"]))
    expect(removed).toEqual([...calls.map(({ method }) => method), ...runtimeEffects])
    expect(JSON.stringify(perturbed)).not.toBe(JSON.stringify(filtered))
  })
})
