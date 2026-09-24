import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../test-support/unsafe-test-value"
import { createIntentRoutingSeal } from "./features/jev"
import { createPluginDispose } from "./plugin-dispose"

describe("createPluginDispose intent routing", () => {
  test("#given a pending sink write #when plugin dispose runs #then the bounded intent-routing flush completes and disposes the sink", async () => {
    // given
    let sinkDisposeCalls = 0
    const seal = createIntentRoutingSeal({
      maxTrackedSessions: 1,
      maxTurnsPerSession: 1,
      processId: "dispose-test",
      turnSealTimeoutMs: 60_000,
      disposeFlushTimeoutMs: 5,
      sink: () => new Promise<void>(() => {}),
      disposeSink: () => {
        sinkDisposeCalls += 1
      },
    })
    seal.handleMessage({
      sessionID: "ses-dispose",
      parts: [{ type: "text", text: "route this" }],
      questionVersion: 1,
      vocabularyDigest: "vocab-digest",
      confidenceThreshold: 0.8,
      configuredModelSpec: "jev-latest",
      predictionTimeoutMs: 100,
      truncatedInput: false,
      notDispatchedReason: "test",
    })
    const intentRouting = {
      dispose: () => seal.dispose(),
    }
    const dispose = createPluginDispose(unsafeTestValue({
      backgroundManager: { shutdown: async () => {} },
      skillMcpManager: { disconnectAll: async () => {} },
      disposeHooks: () => {},
      intentRouting,
    }))

    // when
    const startedAt = performance.now()
    await dispose()
    const elapsedMs = performance.now() - startedAt

    // then
    expect(sinkDisposeCalls).toBe(1)
    expect(elapsedMs).toBeLessThan(100)
  })

  test("#given SIGTERM during a live plugin #when signal cleanup runs #then intent-routing flushes before the signal is re-delivered", async () => {
    const listeners = new Map<string, () => void>()
    const reDelivered: string[] = []
    const flushed = Promise.withResolvers<void>()
    let flushCalls = 0
    createPluginDispose(unsafeTestValue({
      backgroundManager: { shutdown: async () => {} },
      skillMcpManager: { disconnectAll: async () => {} },
      disposeHooks: () => {},
      intentRouting: {
        async dispose() {
          flushCalls += 1
          flushed.resolve()
        },
      },
      processSignals: {
        add(signal: string, listener: () => void) {
          listeners.set(signal, listener)
        },
        remove(signal: string) {
          listeners.delete(signal)
        },
        reDeliver(signal: string) {
          reDelivered.push(signal)
        },
      },
    }))
    const signalHandler = listeners.get("SIGTERM")
    if (signalHandler === undefined) throw new Error("SIGTERM flush handler was not installed")

    signalHandler()
    await flushed.promise
    await Promise.resolve()

    expect(flushCalls).toBe(1)
    expect(reDelivered).toEqual(["SIGTERM"])
    expect(listeners.has("SIGTERM")).toBe(false)
  })
})
