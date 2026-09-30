/// <reference types="bun-types" />

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, spyOn, test } from "bun:test"
import type { DecisionBackend, DecisionOutcome, Questions } from "@oh-my-opencode/jev-core"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../../config"
import { JevConfigSchema } from "../../config/schema/jev"
import type { BackgroundManager } from "../../features/background-agent"
import { createJevCompletionContinuation } from "../../features/jev"
import * as logger from "../../shared/logger"
import type { PluginContext } from "../types"
import { createContinuationHooks } from "./create-continuation-hooks"

const backgroundManager = unsafeTestValue<BackgroundManager>({
  getTasksByParentSession: () => [],
})

function createContext(trace: string[] = []): PluginContext {
  return unsafeTestValue<PluginContext>({
    directory: "/tmp/create-continuation-hooks",
    client: {
      session: {
        messages: async () => {
          trace.push("messages")
          return { data: [{ info: { role: "user", agent: "sisyphus" }, parts: [{ type: "text", text: "work" }] }] }
        },
        todo: async () => {
          trace.push("todos")
          return { data: [{ id: "todo-1", content: "Finish", status: "pending", priority: "high" }] }
        },
      },
      tui: { showToast: async () => { trace.push("toast"); return {} } },
    },
  })
}

describe("createContinuationHooks completion-continuation wiring", () => {
  test("records pre-input skips only in W2 counters", async () => {
    // given
    const adapter = createJevCompletionContinuation({
      jevConfig: JevConfigSchema.parse({
        enabled: true,
        backend: "mock",
        wires: { completion_continuation: { enabled: true } },
      }),
      backend: unsafeTestValue<DecisionBackend>({ kind: "mock" }),
      sink: { append: () => true, flushCounters: () => {}, dispose: () => {} },
      scheduler: () => ({ cancel: () => {} }),
    })

    // when
    adapter.recordPreInputSkip("recovering")
    adapter.recordPreInputSkip("recovering")
    adapter.recordPreInputSkip("messagesUnavailable")

    // then
    expect(adapter.getCounters().starts).toBe(0)
    expect(adapter.getCounters().preInputSkips.recovering).toBe(2)
    expect(adapter.getCounters().preInputSkips.messagesUnavailable).toBe(1)
    await adapter.dispose()
  })

  test("keeps disabled W2 inert without timers, files, backend calls, or observer state", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "jev-w2-disabled-"))
    let backendCalls = 0
    let timerCalls = 0
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        backendCalls += 1
        throw new TypeError("disabled backend must not run")
      },
    }
    const originalSetTimeout = globalThis.setTimeout
    const originalSetInterval = globalThis.setInterval
    globalThis.setTimeout = unsafeTestValue((_callback: TimerHandler) => { timerCalls += 1; return 71 })
    globalThis.setInterval = unsafeTestValue((_callback: TimerHandler) => { timerCalls += 1; return 72 })

    try {
      // when
      const adapter = createJevCompletionContinuation({
        jevConfig: JevConfigSchema.parse({ enabled: false }),
        backend,
        rootDir: root,
      })
      adapter.observeEvent({ type: "session.diff", properties: { sessionID: "disabled", diff: [] } })
      adapter.beginIdle({ sessionID: "disabled", directory: root, todos: [], transcript: [], isContinuationCandidate: false })
      await adapter.dispose()

      // then
      expect(adapter.enabled).toBe(false)
      expect(adapter.inspect()).toEqual({ inFlight: 0, dispatchesDropped: 0, pendingDecisions: 0, diffSessions: 0 })
      expect(adapter.getCounters().starts).toBe(0)
      expect(timerCalls).toBe(0)
      expect(backendCalls).toBe(0)
      expect(existsSync(root)).toBe(true)
      expect(readdirSync(root)).toEqual([])
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.setInterval = originalSetInterval
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("falls back to a no-op observer when W2 construction throws without disabling todo continuation", async () => {
    // given
    const trace: string[] = []
    const logs: string[] = []
    const logSpy = spyOn(logger, "log").mockImplementation((message: string) => { logs.push(message) })
    const originalSetTimeout = globalThis.setTimeout
    const originalSetInterval = globalThis.setInterval
    const originalClearTimeout = globalThis.clearTimeout
    const originalClearInterval = globalThis.clearInterval
    globalThis.setTimeout = unsafeTestValue((_callback: TimerHandler, delay?: number) => { trace.push(`timeout:${delay}`); return 81 })
    globalThis.setInterval = unsafeTestValue((_callback: TimerHandler, delay?: number) => { trace.push(`interval:${delay}`); return 82 })
    globalThis.clearTimeout = unsafeTestValue(() => {})
    globalThis.clearInterval = unsafeTestValue(() => {})
    const malformedConfig = unsafeTestValue<OhMyOpenCodeConfig>({ jev: { enabled: true } })

    try {
      // when
      const hooks = createContinuationHooks({
        ctx: createContext(trace),
        pluginConfig: malformedConfig,
        backgroundManager,
        isHookEnabled: (name) => name === "todo-continuation-enforcer",
        safeHookEnabled: true,
      })
      await hooks.todoContinuationEnforcer?.handler({ event: { type: "session.idle", properties: { sessionID: "construction-failure" } } })

      // then
      expect(hooks.todoContinuationEnforcer).not.toBeNull()
      expect(logs.some((message) => message.includes("completion-continuation observer construction failed"))).toBe(true)
      expect(trace).toEqual(expect.arrayContaining(["messages", "todos", "toast", "interval:1000", "timeout:2000"]))
      hooks.todoContinuationEnforcer?.dispose()
    } finally {
      logSpy.mockRestore()
      globalThis.setTimeout = originalSetTimeout
      globalThis.setInterval = originalSetInterval
      globalThis.clearTimeout = originalClearTimeout
      globalThis.clearInterval = originalClearInterval
    }
  })
})
