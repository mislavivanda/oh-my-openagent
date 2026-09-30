import { describe, expect, test } from "bun:test"
import { createIntentRoutingSealCoordinator } from "./intent-routing-seal"
import { baseTurn } from "./intent-routing-turn-store.test-support"

describe("intent-routing seal adversarial lifecycle", () => {
  test("#given a sink write that never resolves #when dispose flushes #then the bounded await returns", async () => {
    let sinkDisposed = false
    const coordinator = createIntentRoutingSealCoordinator({
      turnSealTimeoutMs: 60_000,
      disposeFlushTimeoutMs: 10,
      createSink: () => ({
        append: () => new Promise<boolean>(() => undefined),
        dispose: () => { sinkDisposed = true },
      }),
    })
    coordinator.startTurn(baseTurn("hung-write", "first"))
    const startedAt = performance.now()

    await coordinator.dispose()

    expect(performance.now() - startedAt).toBeLessThan(250)
    expect(sinkDisposed).toBe(true)
  })

  test("#given a next-turn predecessor #when dispose finalizes the deferred record #then sealedBy alone keeps it reliable", async () => {
    const entries: unknown[] = []
    const coordinator = createIntentRoutingSealCoordinator({
      turnSealTimeoutMs: 60_000,
      createSink: () => ({
        append: (entry) => { entries.push(entry); return true },
        dispose: () => undefined,
      }),
    })
    coordinator.startTurn(baseTurn("mechanical", "first"))
    coordinator.startTurn(baseTurn("mechanical", "second"))

    await coordinator.dispose()

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sealedBy: "next_turn", correlationStatus: "reliable" }),
      expect.objectContaining({ sealedBy: "dispose", correlationStatus: "censored" }),
    ]))
  })
})
