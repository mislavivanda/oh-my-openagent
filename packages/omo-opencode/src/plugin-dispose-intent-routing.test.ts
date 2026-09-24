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
})
