import { describe, expect, test } from "bun:test"
import type { IntentRoutingDecisionResult, IntentRoutingEntry } from "@oh-my-opencode/jev-core"
import { createIntentRoutingTurnStore } from "./intent-routing-turn-store"
import {
  baseTurn,
  deferred,
  filledResult,
  observation,
} from "./intent-routing-turn-store.test-support"

describe("intent-routing observations and eviction", () => {
  test("#given an unresolved prediction #when an observation arrives #then it remains after prediction completion", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const store = createIntentRoutingTurnStore()
    const turn = store.startTurn(baseTurn("observed", "delegate", () => pending.promise))
    expect(turn).not.toBeNull()
    if (turn === null) return

    expect(store.appendObservation("observed", turn.turnOrdinal, observation())).toBe(true)
    pending.resolve(filledResult())
    await turn.settled

    expect(store.getTurn("observed", turn.turnOrdinal)?.observed).toEqual([observation()])
  })

  test("#given max-turn capacity #when five extra turns arrive #then exactly five LRU records are evicted and the newest survive", async () => {
    const entries: IntentRoutingEntry[] = []
    const maxTurnsPerSession = 3
    const store = createIntentRoutingTurnStore({
      maxTurnsPerSession,
      onEntry: (entry) => entries.push(entry),
      processId: "eviction-test",
    })

    for (let index = 0; index < maxTurnsPerSession + 5; index += 1) {
      const turn = store.startTurn(baseTurn("lru", `turn-${index}`, async () => filledResult()))
      await turn?.settled
    }

    const snapshot = store.inspect()
    expect(snapshot.evictedCount).toBe(5)
    expect(store.getSessionTurns("lru").map((record) => record.normalizedPrompt)).toEqual([
      "turn-5",
      "turn-6",
      "turn-7",
    ])
    expect(entries.some((entry) => entry.kind === "counter_delta" && entry.counters.recordsEvicted === 5)).toBe(true)
  })

  test("#given a deferred-finalization predecessor #when LRU pressure arrives #then another record is evicted first", async () => {
    const store = createIntentRoutingTurnStore({ maxTurnsPerSession: 2 })
    const first = store.startTurn(baseTurn("deferred", "first", async () => filledResult()))
    const second = store.startTurn(baseTurn("deferred", "second", async () => filledResult()))
    await Promise.all([first?.settled, second?.settled])
    if (first === null || second === null) return
    store.sealTurn({
      sessionID: "deferred",
      turnOrdinal: first.turnOrdinal,
      sealedBy: "next_turn",
      deferFinalization: true,
    })

    const third = store.startTurn(baseTurn("deferred", "third", async () => filledResult()))
    await third?.settled

    expect(store.getTurn("deferred", first.turnOrdinal)?.terminalState).toBe("sealed")
    expect(store.getTurn("deferred", second.turnOrdinal)).toBeUndefined()
  })

  test("#given only a deferred record can satisfy capacity #when another turn starts #then it is force-finalized as censored instead of dropped", async () => {
    const entries: IntentRoutingEntry[] = []
    const store = createIntentRoutingTurnStore({
      maxTurnsPerSession: 1,
      onEntry: (entry) => entries.push(entry),
    })
    const first = store.startTurn(baseTurn("forced", "first", async () => filledResult()))
    await first?.settled
    if (first === null) return
    store.sealTurn({
      sessionID: "forced",
      turnOrdinal: first.turnOrdinal,
      sealedBy: "next_turn",
      deferFinalization: true,
    })

    const second = store.startTurn(baseTurn("forced", "second", async () => filledResult()))
    await second?.settled

    const finalized = entries.find((entry) => entry.kind === "observation")
    expect(finalized?.kind).toBe("observation")
    if (finalized?.kind !== "observation") return
    expect(finalized.correlationStatus).toBe("censored")
    expect(store.inspect().evictedCount).toBe(0)
  })
})
