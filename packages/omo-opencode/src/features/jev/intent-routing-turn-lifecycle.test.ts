import { describe, expect, mock, test } from "bun:test"
import type { IntentRoutingDecisionResult, IntentRoutingEntry } from "@oh-my-opencode/jev-core"
import {
  createIntentRoutingTurnStore,
  normalizeIntentRoutingPrompt,
} from "./intent-routing-turn-store"
import {
  baseTurn,
  filledResult,
  observation,
  textParts,
} from "./intent-routing-turn-store.test-support"

describe("intent-routing lifecycle", () => {
  test("#given pending and completed maps #when session.deleted fires #then pending becomes timeout, records finalize, and all session keys clear", async () => {
    const entries: IntentRoutingEntry[] = []
    const store = createIntentRoutingTurnStore({ onEntry: (entry) => entries.push(entry) })
    const pending = store.startTurn(baseTurn("deleted", "pending", () => new Promise(() => undefined)))
    const filled = store.startTurn(baseTurn("deleted", "filled", async () => filledResult()))
    await filled?.settled

    store.deleteSession("deleted")
    await pending?.settled

    expect(store.inspect()).toMatchObject({
      sessionCount: 0,
      pendingCoalescingCount: 0,
      completedCacheCount: 0,
    })
    const observations = entries.filter((entry) => entry.kind === "observation")
    expect(observations).toHaveLength(2)
    expect(observations.every((entry) => entry.sealedBy === "session_deleted")).toBe(true)
    expect(observations.some((entry) => entry.predictionStatus === "timeout")).toBe(true)
  })

  test("#given a never-resolving prediction #when its deadline passes #then it settles as prediction_timeout", async () => {
    const store = createIntentRoutingTurnStore({ predictionTimeoutMs: 10 })
    const turn = store.startTurn(baseTurn("timeout", "hang", () => new Promise(() => undefined)))
    expect(turn).not.toBeNull()
    if (turn === null) return

    await turn.settled

    expect(store.getTurn("timeout", turn.turnOrdinal)?.lifecycleState).toBe("prediction_timeout")
    expect(store.getTurn("timeout", turn.turnOrdinal)?.predictionState).toBe("timeout")
  })

  test("#given whitespace, case, punctuation, and system reminders #when prompts normalize #then only the exact normalized text collides", () => {
    const store = createIntentRoutingTurnStore({ predictionTimeoutMs: 500 })
    const dispatch = () => new Promise<IntentRoutingDecisionResult>(() => undefined)
    const padded = store.startTurn(baseTurn("normalize", "  Continue  ", dispatch))
    const plain = store.startTurn(baseTurn("normalize", "continue", dispatch))
    const punctuation = store.startTurn(baseTurn("normalize", "continue!", dispatch))
    const reminded = store.startTurn({
      ...baseTurn("normalize", "unused", dispatch),
      parts: [
        { type: "text", text: "<system-reminder>ignore me</system-reminder>" },
        { type: "text", text: "  CONTINUE  " },
      ],
    })

    expect(padded?.dedupKey).toBe(plain?.dedupKey)
    expect(reminded?.dedupKey).toBe(plain?.dedupKey)
    expect(punctuation?.dedupKey).not.toBe(plain?.dedupKey)
    expect(normalizeIntentRoutingPrompt(textParts("  Continue\n\tNow  "))).toBe("continue now")
    store.deleteSession("normalize")
  })

  test("#given empty, reminder-only, null-session, minimum capacity, and orphan inputs #when processed #then the store remains bounded and fail-closed", async () => {
    const dispatch = mock(async () => filledResult())
    const store = createIntentRoutingTurnStore({ maxTurnsPerSession: 1 })
    const empty = store.startTurn({ ...baseTurn("malformed", "unused", dispatch), parts: [] })
    const reminderOnly = store.startTurn({
      ...baseTurn("malformed", "unused", dispatch),
      parts: [{ type: "text", text: "<system-reminder>internal</system-reminder>" }],
    })
    const nullSession = store.startTurn({ ...baseTurn("unused", "text", dispatch), sessionID: null })
    await Promise.all([empty?.settled, reminderOnly?.settled])

    expect(empty?.promptHash).toBe(reminderOnly?.promptHash)
    expect(nullSession).toBeNull()
    expect(store.getSessionTurns("malformed")).toHaveLength(1)
    expect(store.appendObservation("malformed", 999_999, observation("orphan"))).toBe(false)
    expect(store.getCounters().orphanObservations).toBe(1)
  })

  test("#given deletion and dispose interleaved with pending work #when repeated #then terminalization ordering is idempotent", async () => {
    const entries: IntentRoutingEntry[] = []
    const store = createIntentRoutingTurnStore({ onEntry: (entry) => entries.push(entry) })
    const turn = store.startTurn(baseTurn("interrupt", "pending", () => new Promise(() => undefined)))

    store.deleteSession("interrupt")
    store.deleteSession("interrupt")
    store.dispose()
    store.dispose()
    await turn?.settled

    const observations = entries.filter((entry) => entry.kind === "observation")
    expect(observations).toHaveLength(1)
    expect(observations[0]?.predictionStatus).toBe("timeout")
    expect(observations[0]?.sealedBy).toBe("session_deleted")
  })
})
