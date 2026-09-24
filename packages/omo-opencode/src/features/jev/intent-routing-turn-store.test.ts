import { describe, expect, mock, test } from "bun:test"
import type { IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import { createIntentRoutingTurnStore } from "./intent-routing-turn-store"
import {
  baseTurn,
  deferred,
  failedResult,
  filledResult,
  FLOATING_MODEL,
  PINNED_MODEL,
} from "./intent-routing-turn-store.test-support"

describe("intent-routing turn identity and two-tier reuse", () => {
  test("#given the same prompt twice #when both turns are created #then distinct local ordinals retain the shared dedup key", async () => {
    const store = createIntentRoutingTurnStore()
    const first = store.startTurn(baseTurn("same-prompt", "continue", async () => filledResult()))
    const second = store.startTurn(baseTurn("same-prompt", "continue", async () => filledResult()))

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) return
    await Promise.all([first.settled, second.settled])

    expect(first.turnOrdinal).not.toBe(second.turnOrdinal)
    expect(first.dedupKey).toBe(second.dedupKey)
    expect(store.getSessionTurns("same-prompt")).toHaveLength(2)
  })

  test("#given interleaved sessions #when one session creates its second turn #then its local ordinal increments without the other session", async () => {
    const store = createIntentRoutingTurnStore()
    const firstA = store.startTurn(baseTurn("session-a", "first-a", async () => filledResult()))
    const firstB = store.startTurn(baseTurn("session-b", "first-b", async () => filledResult()))
    await Promise.all([firstA?.settled, firstB?.settled])

    const secondA = store.startTurn(baseTurn("session-a", "second-a", async () => filledResult()))
    await secondA?.settled

    expect(firstA?.turnOrdinal).toBe(1)
    expect(secondA?.turnOrdinal).toBe(2)
  })

  test("#given a matching pending predecessor #when a second turn starts #then one tier-one dispatch fills both ordinals independently", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const dispatch = mock(() => pending.promise)
    const store = createIntentRoutingTurnStore({ predictionTimeoutMs: 500 })
    const input = { ...baseTurn("pending", "continue", dispatch), configuredModelSpec: FLOATING_MODEL }
    const first = store.startTurn(input)
    const second = store.startTurn(input)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) return
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(first.dedupKey).toBe(second.dedupKey)
    expect(first.dedupKey).not.toContain(PINNED_MODEL)

    pending.resolve(filledResult())
    await Promise.all([first.settled, second.settled])
    const firstRecord = store.getTurn("pending", first.turnOrdinal)
    const secondRecord = store.getTurn("pending", second.turnOrdinal)

    expect(firstRecord?.predictionState).toBe("filled")
    expect(secondRecord?.predictionState).toBe("filled")
    expect(firstRecord?.answers).toEqual(secondRecord?.answers)
    expect(firstRecord?.predictionReused).toBe(false)
    expect(secondRecord?.predictionReused).toBe(false)
  })

  test("#given a filled predecessor with a pinned model #when the prompt repeats #then tier-two reuse copies answers without dispatch", async () => {
    const dispatch = mock(async () => filledResult())
    const store = createIntentRoutingTurnStore()
    const first = store.startTurn(baseTurn("pinned", "continue", dispatch))
    expect(first).not.toBeNull()
    if (first === null) return
    await first.settled

    const second = store.startTurn(baseTurn("pinned", "continue", dispatch))
    expect(second).not.toBeNull()
    if (second === null) return
    await second.settled

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(store.getTurn("pinned", second.turnOrdinal)?.predictionReused).toBe(true)
    expect(store.getTurn("pinned", second.turnOrdinal)?.reuseKey).toContain(PINNED_MODEL)
  })

  test("#given a filled predecessor with an unresolved floating alias #when the prompt repeats #then completed reuse is blocked", async () => {
    const dispatch = mock(async () => filledResult())
    const store = createIntentRoutingTurnStore()
    const input = { ...baseTurn("floating", "continue", dispatch), configuredModelSpec: FLOATING_MODEL }
    const first = store.startTurn(input)
    expect(first).not.toBeNull()
    if (first === null) return
    await first.settled

    const second = store.startTurn(input)
    expect(second).not.toBeNull()
    if (second === null) return
    await second.settled

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(store.getTurn("floating", second.turnOrdinal)?.predictionReused).toBe(false)
  })
})

describe("intent-routing reuse exclusions", () => {
  test.each(["failed", "timeout", "not_dispatched", "evicted"] as const)(
    "#given a %s predecessor #when the prompt repeats #then a fresh dispatch runs without reuse",
    async (predecessor) => {
      const freshDispatch = mock(async () => filledResult())
      const store = createIntentRoutingTurnStore({
        maxTurnsPerSession: predecessor === "evicted" ? 1 : 8,
        predictionTimeoutMs: 10,
      })

      if (predecessor === "failed") {
        const turn = store.startTurn(baseTurn("excluded", "continue", async () => failedResult()))
        await turn?.settled
      } else if (predecessor === "timeout") {
        const turn = store.startTurn(baseTurn("excluded", "continue", () => new Promise(() => undefined)))
        await turn?.settled
      } else if (predecessor === "not_dispatched") {
        const turn = store.startTurn({
          ...baseTurn("excluded", "continue"),
          notDispatchedReason: "capacity",
        })
        await turn?.settled
      } else {
        const turn = store.startTurn(baseTurn("excluded", "continue", async () => filledResult()))
        await turn?.settled
        const evicting = store.startTurn(baseTurn("excluded", "different", async () => filledResult()))
        await evicting?.settled
      }

      const repeated = store.startTurn(baseTurn("excluded", "continue", freshDispatch))
      await repeated?.settled

      expect(freshDispatch).toHaveBeenCalledTimes(1)
      expect(repeated === null
        ? undefined
        : store.getTurn("excluded", repeated.turnOrdinal)?.predictionReused).toBe(false)
    },
  )

  test.each([
    ["questionVersion", { questionVersion: 2 }],
    ["vocabularyDigest", { vocabularyDigest: "vocab-b" }],
    ["confidenceThreshold", { confidenceThreshold: 0.9 }],
    ["configuredModelSpec", { configuredModelSpec: "jev-1.14.0" }],
  ])(
    "#given a pending predecessor #when %s changes #then the tier-one key changes and dispatch is fresh",
    async (_field, changed) => {
      const dispatch = mock(() => new Promise<IntentRoutingDecisionResult>(() => undefined))
      const store = createIntentRoutingTurnStore({ predictionTimeoutMs: 500 })
      const first = store.startTurn(baseTurn("key-change", "continue", dispatch))
      const second = store.startTurn({ ...baseTurn("key-change", "continue", dispatch), ...changed })

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      if (first === null || second === null) return
      expect(first.dedupKey).not.toBe(second.dedupKey)
      expect(dispatch).toHaveBeenCalledTimes(2)
      store.deleteSession("key-change")
      await Promise.all([first.settled, second.settled])
    },
  )
})
