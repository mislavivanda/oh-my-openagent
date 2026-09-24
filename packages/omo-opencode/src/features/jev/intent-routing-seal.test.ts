import { afterEach, describe, expect, jest, test } from "bun:test"
import { rmSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { JevConfigSchema } from "../../config/schema/jev"
import { readIntentRoutingSink } from "./intent-routing-reader"
import {
  createIntentRoutingSealCoordinator,
  type IntentRoutingSealCoordinator,
} from "./intent-routing-seal"
import { createIntentRoutingSink } from "./intent-routing-sink"
import {
  baseTurn,
  filledResult,
  observation,
} from "./intent-routing-turn-store.test-support"

type Harness = {
  readonly coordinator: IntentRoutingSealCoordinator
  readonly rootDir: string
}

const harnesses: Harness[] = []

function createHarness(turnSealTimeoutMs = 60_000): Harness {
  const rootDir = join(homedir(), ".omo", "jev", `task-12-${randomUUID()}`)
  const coordinator = createIntentRoutingSealCoordinator({
    turnSealTimeoutMs,
    createSink: (getCounters) => createIntentRoutingSink({
      rootDir,
      getCounters,
      counterFlushIntervalMs: 60_000,
    }),
  })
  const harness = { coordinator, rootDir }
  harnesses.push(harness)
  return harness
}

function persisted(harness: Harness) {
  return readIntentRoutingSink(harness.rootDir).observations
}

afterEach(async () => {
  jest.useRealTimers()
  for (const harness of harnesses.splice(0)) {
    await harness.coordinator.dispose()
    rmSync(harness.rootDir, { recursive: true, force: true })
  }
})

describe("intent-routing seal paths", () => {
  test("#given a live turn #when a real successor starts #then next_turn seals it reliably", () => {
    const harness = createHarness()
    const first = harness.coordinator.startTurn(baseTurn("next-turn", "first"))
    harness.coordinator.startTurn(baseTurn("next-turn", "second"))

    expect(first).not.toBeNull()
    if (first === null) return
    expect(harness.coordinator.store.getTurn("next-turn", first.turnOrdinal)).toMatchObject({
      terminalState: "sealed", sealedBy: "next_turn", correlationStatus: "reliable",
    })
  })

  test("#given a live turn #when session idle fires #then session_idle finalizes it reliably", () => {
    const harness = createHarness()
    harness.coordinator.startTurn(baseTurn("idle", "first"))

    expect(harness.coordinator.sealSessionIdle("idle")).toBe(true)

    expect(persisted(harness)).toEqual([
      expect.objectContaining({ sealedBy: "session_idle", correlationStatus: "reliable" }),
    ])
  })

  test("#given a live turn #when its seal timer fires #then seal_timeout is censored", () => {
    jest.useFakeTimers()
    const harness = createHarness(10)
    harness.coordinator.startTurn(baseTurn("seal-timeout", "first"))

    jest.advanceTimersByTime(10)

    expect(persisted(harness)).toEqual([
      expect.objectContaining({ sealedBy: "seal_timeout", correlationStatus: "censored" }),
    ])
  })

  test("#given a live turn #when dispose fires #then dispose is censored", async () => {
    const harness = createHarness()
    harness.coordinator.startTurn(baseTurn("dispose", "first"))

    await harness.coordinator.dispose()

    expect(persisted(harness)).toEqual([
      expect.objectContaining({ sealedBy: "dispose", correlationStatus: "censored" }),
    ])
  })
})

describe("intent-routing logical seal and finalization", () => {
  test("#given a live turn #when a synthetic message arrives #then it neither seals nor creates a successor", () => {
    const harness = createHarness()
    const first = harness.coordinator.startTurn(baseTurn("synthetic", "first"))

    const synthetic = harness.coordinator.startTurn({
      ...baseTurn("synthetic", "internal"),
      parts: [{ type: "text", text: "internal", synthetic: true }],
    })

    expect(synthetic).toBeNull()
    expect(first === null ? undefined : harness.coordinator.store.getTurn("synthetic", first.turnOrdinal)?.terminalState).toBe("live")
  })

  test("#given a sealed turn without a successor #when delegation arrives #then it becomes an orphan counter delta", () => {
    const harness = createHarness()
    const turn = harness.coordinator.startTurn(baseTurn("orphan", "first"))
    harness.coordinator.sealSessionIdle("orphan")

    expect(turn).not.toBeNull()
    if (turn === null) return
    expect(harness.coordinator.store.appendObservation("orphan", turn.turnOrdinal, observation())).toBe(false)
    const counters = readIntentRoutingSink(harness.rootDir).entries
      .filter((entry) => entry.kind === "counter_delta")
    expect(counters.at(-1)?.kind === "counter_delta" ? counters.at(-1)?.counters.orphanObservations : 0).toBe(1)
  })

  test("#given turn two logically seals turn one #when turn two seals #then turn one appends once without an update path", () => {
    const harness = createHarness()
    const first = harness.coordinator.startTurn(baseTurn("deferred", "first"))
    harness.coordinator.startTurn(baseTurn("deferred", "second"))

    expect(persisted(harness)).toHaveLength(0)
    harness.coordinator.sealSessionIdle("deferred")

    expect(first).not.toBeNull()
    expect(persisted(harness).filter((entry) => entry.turnOrdinal === first?.turnOrdinal)).toHaveLength(1)
    expect("update" in harness.coordinator).toBe(false)
  })

  test("#given turn one sealed by turn two #when a late observation arrives #then both sides become overlap ambiguous before append", () => {
    const harness = createHarness()
    const first = harness.coordinator.startTurn(baseTurn("overlap", "first"))
    const synthetic = harness.coordinator.startTurn({
      ...baseTurn("overlap", "internal"),
      parts: [{ type: "text", text: "internal", synthetic: true }],
    })
    expect(synthetic).toBeNull()
    expect(first === null ? undefined : harness.coordinator.store.getTurn("overlap", first.turnOrdinal)?.terminalState).toBe("live")
    const second = harness.coordinator.startTurn(baseTurn("overlap", "second"))
    if (first === null || second === null) return

    expect(harness.coordinator.store.appendObservation("overlap", second.turnOrdinal, observation("late"))).toBe(true)
    expect(harness.coordinator.store.getTurn("overlap", first.turnOrdinal)?.correlationStatus).toBe("overlap_ambiguous")
    expect(harness.coordinator.store.getTurn("overlap", second.turnOrdinal)?.correlationStatus).toBe("overlap_ambiguous")
    expect(persisted(harness)).toHaveLength(0)

    harness.coordinator.sealSessionIdle("overlap")
    expect(persisted(harness).map((entry) => entry.correlationStatus)).toEqual([
      "overlap_ambiguous", "overlap_ambiguous",
    ])
  })
})

describe("intent-routing bias and interruption safety", () => {
  test("#given a none prediction with no observations #when timeout seals it #then headline rates exclude the censored agreement", async () => {
    jest.useFakeTimers()
    const harness = createHarness(10)
    const turn = harness.coordinator.startTurn(baseTurn("inflation", "first", async () => filledResult(undefined, "none")))
    await turn?.settled

    jest.advanceTimersByTime(10)

    const records = persisted(harness)
    expect(records[0]).toMatchObject({ sealedBy: "seal_timeout", correlationStatus: "censored", observed: [] })
    expect(records.filter((entry) => entry.correlationStatus === "reliable")).toHaveLength(0)
  })

  test("#given pending predictions #when dispose and deletion interrupt #then both force timeout without hanging", async () => {
    const harness = createHarness()
    harness.coordinator.startTurn(baseTurn("deleted", "first", () => new Promise(() => undefined)))
    harness.coordinator.deleteSession("deleted")
    harness.coordinator.startTurn(baseTurn("disposed", "first", () => new Promise(() => undefined)))

    await harness.coordinator.dispose()

    expect(persisted(harness)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionID: "deleted", sealedBy: "session_deleted", predictionStatus: "timeout" }),
      expect.objectContaining({ sessionID: "disposed", sealedBy: "dispose", predictionStatus: "timeout" }),
    ]))
  })

  test("#given repeated interruptions and malformed lifecycle input #when replayed #then finalization remains idempotent", async () => {
    const harness = createHarness()
    const turn = harness.coordinator.startTurn(baseTurn("repeat", "first"))
    expect(harness.coordinator.sealSessionIdle("missing")).toBe(false)
    expect(harness.coordinator.sealSessionIdle("repeat")).toBe(true)
    expect(harness.coordinator.sealSessionIdle("repeat")).toBe(false)
    expect(turn === null ? true : harness.coordinator.store.sealTurn({
      sessionID: "repeat", turnOrdinal: turn.turnOrdinal, sealedBy: "session_idle",
    })).toBe(false)
    expect(harness.coordinator.store.appendObservation("repeat", turn?.turnOrdinal ?? -1, observation("late"))).toBe(false)

    await Promise.all([harness.coordinator.dispose(), harness.coordinator.dispose()])

    const records = persisted(harness)
    expect(records).toHaveLength(1)
    expect(records.every((entry) => entry.sealedBy !== undefined && entry.correlationStatus !== undefined)).toBe(true)
  })

  test("#given an invalid timeout ordering #when config parses #then turn seal timeout at or below prediction is rejected", () => {
    expect(() => JevConfigSchema.parse({
      wires: { intent_routing: { timeout_ms: 2500, turn_seal_timeout_ms: 2500 } },
    })).toThrow(/strictly greater/u)
  })
})
