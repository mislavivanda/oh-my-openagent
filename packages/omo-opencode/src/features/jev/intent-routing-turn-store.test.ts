// allow: SIZE_OK - the load-bearing key, reuse, lifecycle, and eviction matrix is kept in one acceptance suite.

import { describe, expect, test } from "bun:test"
import type {
  IntentRoutingAnswers,
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"
import {
  createIntentRoutingTurnStore,
  normalizeIntentRoutingPrompt,
  type IntentRoutingTurnInput,
} from "./intent-routing-turn-store"

const SESSION_ID = "session-a"
const PINNED_MODEL = "jev-1.13.0"
const FLOATING_MODEL = "jev-latest"
const ANSWERS: IntentRoutingAnswers = {
  intent: { choice: "implementation", confidence: 0.9, probabilities: { implementation: 0.9, research: 0.1 }, valid: true },
  category: { choice: "deep", confidence: 0.9, probabilities: { deep: 0.9, none: 0.1 }, valid: true },
  subagent: { choice: "none", confidence: 0.9, probabilities: { none: 0.9, explore: 0.1 }, valid: true },
  ambiguous: { noul: 0.1, valid: true },
}
const FILLED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "filled",
  unavailableReason: null,
  resolvedModel: PINNED_MODEL,
  latencyMs: 4,
  truncatedInput: false,
  answers: ANSWERS,
  labels: { intent: "would_apply", category: "would_apply", subagent: "would_apply" },
  invalidAnswerCount: 0,
  questionVersion: 1,
}
const FAILED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "failed",
  unavailableReason: "transport_error",
  resolvedModel: null,
  latencyMs: 3,
  truncatedInput: false,
  answers: null,
  labels: null,
  invalidAnswerCount: 0,
  questionVersion: 1,
}
const OBSERVATION: IntentRoutingObservedDelegation = {
  tool: "task",
  category: "deep",
  subagentType: null,
  requestedSubagentType: null,
  taskId: null,
  normalizedCategory: "deep",
  normalizedSubagent: "none",
  routeClass: "category",
  callID: "call-1",
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized")
      resolvePromise(value)
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function turnInput(overrides: Partial<IntentRoutingTurnInput> = {}): IntentRoutingTurnInput {
  return {
    sessionID: SESSION_ID,
    parts: [{ type: "text", text: "continue" }],
    questionVersion: 1,
    vocabularyDigest: "vocab-a",
    confidenceThreshold: 0.8,
    configuredModelSpec: PINNED_MODEL,
    predictionTimeoutMs: 100,
    truncatedInput: false,
    dispatch: async () => FILLED_RESULT,
    ...overrides,
  }
}

function createHarness(options: { readonly maxTurnsPerSession?: number; readonly maxTrackedSessions?: number } = {}) {
  const entries: IntentRoutingEntry[] = []
  const store = createIntentRoutingTurnStore({
    maxTurnsPerSession: options.maxTurnsPerSession ?? 8,
    maxTrackedSessions: options.maxTrackedSessions ?? 8,
    processId: "turn-store-test",
    sink: (entry) => { entries.push(entry) },
  })
  return { entries, store }
}

describe("createIntentRoutingTurnStore", () => {
  test("#given the same prompt twice #when both records are created #then their locally minted ordinals are distinct", () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const { store } = createHarness()

    const first = store.createTurn(turnInput({ dispatch: () => pending.promise }))
    const second = store.createTurn(turnInput({ dispatch: () => pending.promise }))

    expect(first.turnOrdinal).toBe(1)
    expect(second.turnOrdinal).toBe(2)
    expect(first.turnOrdinal).not.toBe(second.turnOrdinal)
    expect(first.dedupKey).toBe(second.dedupKey)
  })

  test("#given a pending predecessor #when an identical prompt repeats #then tier-one coalesces without a second dispatch or blocking", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const { store } = createHarness()
    let dispatches = 0
    const input = turnInput({
      configuredModelSpec: FLOATING_MODEL,
      dispatch: () => { dispatches += 1; return pending.promise },
    })

    const first = store.createTurn(input)
    const second = store.createTurn(input)
    expect(dispatches).toBe(1)
    expect(first.predictionStatus).toBe("pending")
    expect(second.predictionStatus).toBe("pending")
    expect(first.dedupKey).not.toContain(PINNED_MODEL)

    pending.resolve(FILLED_RESULT)
    await settle()

    expect(store.getTurn(SESSION_ID, first.turnOrdinal)?.answers).toEqual(ANSWERS)
    expect(store.getTurn(SESSION_ID, second.turnOrdinal)?.answers).toEqual(ANSWERS)
  })

  test("#given a filled predecessor using a pinned model #when the prompt repeats #then tier-two reuses the completed prediction", async () => {
    const { store } = createHarness()
    let dispatches = 0
    const input = turnInput({ dispatch: async () => { dispatches += 1; return FILLED_RESULT } })
    store.createTurn(input)
    await settle()

    const repeated = store.createTurn(input)

    expect(dispatches).toBe(1)
    expect(repeated.predictionStatus).toBe("filled")
    expect(repeated.predictionReused).toBe(true)
    expect(repeated.reuseKey).toContain(PINNED_MODEL)
  })

  test("#given a filled predecessor using a floating alias #when current resolution is unknown #then completed reuse is disabled", async () => {
    const { store } = createHarness()
    let dispatches = 0
    const input = turnInput({
      configuredModelSpec: FLOATING_MODEL,
      dispatch: async () => { dispatches += 1; return FILLED_RESULT },
    })
    store.createTurn(input)
    await settle()

    const repeated = store.createTurn(input)
    await settle()

    expect(dispatches).toBe(2)
    expect(repeated.predictionReused).toBe(false)
  })

  test("#given a floating alias with an independently known resolution #when the prompt repeats #then matching tier-two reuse is allowed", async () => {
    const { store } = createHarness()
    let dispatches = 0
    const input = turnInput({
      configuredModelSpec: FLOATING_MODEL,
      currentResolvedModel: PINNED_MODEL,
      dispatch: async () => { dispatches += 1; return FILLED_RESULT },
    })
    store.createTurn(input)
    await settle()

    const repeated = store.createTurn(input)

    expect(dispatches).toBe(1)
    expect(repeated.predictionReused).toBe(true)
  })

  test("#given a failed predecessor #when the prompt repeats #then a fresh prediction dispatches", async () => {
    const { store } = createHarness()
    let dispatches = 0
    const input = turnInput({ dispatch: async () => { dispatches += 1; return FAILED_RESULT } })
    store.createTurn(input)
    await settle()

    const repeated = store.createTurn(input)
    await settle()

    expect(dispatches).toBe(2)
    expect(repeated.predictionReused).toBe(false)
  })

  test("#given a timed-out predecessor #when the prompt repeats #then a fresh prediction dispatches", async () => {
    const { store } = createHarness()
    let dispatches = 0
    const never = deferred<IntentRoutingDecisionResult>()
    const input = turnInput({
      predictionTimeoutMs: 0,
      dispatch: () => { dispatches += 1; return never.promise },
    })
    const first = store.createTurn(input)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const repeated = store.createTurn(input)

    expect(store.getTurn(SESSION_ID, first.turnOrdinal)?.predictionStatus).toBe("timeout")
    expect(dispatches).toBe(2)
    expect(repeated.predictionReused).toBe(false)
  })

  test("#given a not-dispatched predecessor #when the prompt repeats #then it dispatches fresh", async () => {
    const { store } = createHarness()
    store.createTurn(turnInput({ dispatch: undefined, notDispatchedReason: "max_inflight" }))
    let dispatches = 0

    const repeated = store.createTurn(turnInput({ dispatch: async () => { dispatches += 1; return FILLED_RESULT } }))
    await settle()

    expect(dispatches).toBe(1)
    expect(repeated.predictionReused).toBe(false)
  })

  test("#given an evicted predecessor #when its prompt returns #then it dispatches fresh", async () => {
    const { store } = createHarness({ maxTurnsPerSession: 1 })
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    store.createTurn(turnInput({ parts: [{ type: "text", text: "first" }], dispatch }))
    await settle()
    store.createTurn(turnInput({ parts: [{ type: "text", text: "second" }], dispatch }))
    await settle()

    const repeated = store.createTurn(turnInput({ parts: [{ type: "text", text: "first" }], dispatch }))
    await settle()

    expect(dispatches).toBe(3)
    expect(repeated.predictionReused).toBe(false)
  })

  for (const [field, override] of [
    ["questionVersion", { questionVersion: 2 }],
    ["vocabularyDigest", { vocabularyDigest: "vocab-b" }],
    ["confidenceThreshold", { confidenceThreshold: 0.7 }],
    ["configuredModelSpec", { configuredModelSpec: "jev-1.14.0" }],
  ] satisfies ReadonlyArray<readonly [string, Partial<IntentRoutingTurnInput>]>) {
    test(`#given a pending predecessor #when ${field} changes #then tier-one differs and dispatches fresh`, () => {
      const pending = deferred<IntentRoutingDecisionResult>()
      const { store } = createHarness()
      let dispatches = 0
      const dispatch = () => { dispatches += 1; return pending.promise }
      const first = store.createTurn(turnInput({ dispatch }))

      const changed = store.createTurn(turnInput({ ...override, dispatch }))

      expect(dispatches).toBe(2)
      expect(changed.dedupKey).not.toBe(first.dedupKey)
    })
  }

  test("#given observations arrive before prediction completion #when the prediction resolves #then the observations remain on the ordinal", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const { store } = createHarness()
    const created = store.createTurn(turnInput({ dispatch: () => pending.promise }))

    expect(store.appendObservation(SESSION_ID, OBSERVATION)).toBe(true)
    pending.resolve(FILLED_RESULT)
    await settle()

    expect(store.getTurn(SESSION_ID, created.turnOrdinal)?.observed).toEqual([OBSERVATION])
  })

  test("#given maxTurnsPerSession plus five turns #when capacity is enforced #then five evictions are durable and newest turns survive", async () => {
    const maxTurnsPerSession = 3
    const { entries, store } = createHarness({ maxTurnsPerSession })
    for (let index = 1; index <= maxTurnsPerSession + 5; index += 1) {
      store.createTurn(turnInput({ parts: [{ type: "text", text: `turn ${index}` }] }))
      await settle()
    }

    const survivors = store.listTurns(SESSION_ID).map((turn) => turn.turnOrdinal)
    const deltas = entries.filter((entry) => entry.kind === "counter_delta")

    expect(store.evictedCount).toBe(5)
    expect(survivors).toEqual([6, 7, 8])
    expect(deltas.at(-1)?.counters.recordsEvicted).toBe(5)
  })

  test("#given a logically sealed deferred record #when an ordinary victim exists #then LRU exempts the deferred record", async () => {
    const { store } = createHarness({ maxTurnsPerSession: 2 })
    const first = store.createTurn(turnInput({ parts: [{ type: "text", text: "first" }] }))
    await settle()
    store.sealTurn(SESSION_ID, first.turnOrdinal, "next_turn")
    store.createTurn(turnInput({ parts: [{ type: "text", text: "second" }] }))
    await settle()

    store.createTurn(turnInput({ parts: [{ type: "text", text: "third" }] }))
    await settle()

    expect(store.listTurns(SESSION_ID).map((turn) => turn.turnOrdinal)).toEqual([1, 3])
  })

  test("#given only a logically sealed deferred victim #when capacity is reached #then the exemption prevents premature finalization", async () => {
    const { entries, store } = createHarness({ maxTurnsPerSession: 1 })
    const first = store.createTurn(turnInput({ parts: [{ type: "text", text: "first" }] }))
    await settle()
    store.sealTurn(SESSION_ID, first.turnOrdinal, "next_turn")

    store.createTurn(turnInput({ parts: [{ type: "text", text: "second" }] }))
    await settle()

    expect(entries.filter((entry) => entry.kind === "observation")).toHaveLength(0)
    expect(store.listTurns(SESSION_ID).map((turn) => turn.turnOrdinal)).toEqual([1, 2])
    store.sealTurn(SESSION_ID, 2, "session_idle")

    const observation = entries.find((entry) => entry.kind === "observation" && entry.turnOrdinal === first.turnOrdinal)
    expect(observation?.sealedBy).toBe("next_turn")
    expect(observation?.correlationStatus).toBe("reliable")
    expect(store.evictedCount).toBe(0)
  })

  test("#given session and reuse maps contain pending turns #when session.deleted is handled #then predictions timeout, records finalize, and both maps clear", () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const { entries, store } = createHarness()
    const input = turnInput({ dispatch: () => pending.promise })
    store.createTurn(input)
    store.createTurn(input)

    store.deleteSession(SESSION_ID)

    const records = entries.filter((entry) => entry.kind === "observation")
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.predictionStatus === "timeout")).toBe(true)
    expect(records.every((record) => record.sealedBy === "session_deleted")).toBe(true)
    expect(store.trackedSessionCount).toBe(0)
    expect(store.reuseEntryCount).toBe(0)
  })

  test("#given a never-resolving prediction #when its prediction timer fires #then it becomes prediction_timeout", async () => {
    const never = deferred<IntentRoutingDecisionResult>()
    const { store } = createHarness()
    const turn = store.createTurn(turnInput({ predictionTimeoutMs: 0, dispatch: () => never.promise }))

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(store.getTurn(SESSION_ID, turn.turnOrdinal)?.predictionStatus).toBe("timeout")
  })

  test("#given whitespace, casing, and system reminders #when prompts normalize #then equivalent continue text collides but punctuation does not", () => {
    const { store } = createHarness()
    let dispatches = 0
    const pending = deferred<IntentRoutingDecisionResult>()
    const dispatch = () => { dispatches += 1; return pending.promise }
    const padded = store.createTurn(turnInput({
      parts: [{ type: "text", text: "  Continue  <system-reminder>ignore me</system-reminder>" }],
      dispatch,
    }))
    const plain = store.createTurn(turnInput({ parts: [{ type: "text", text: "continue" }], dispatch }))
    const punctuated = store.createTurn(turnInput({ parts: [{ type: "text", text: "continue!" }], dispatch }))

    expect(normalizeIntentRoutingPrompt([{ type: "text", text: "  Continue  " }])).toBe("continue")
    expect(padded.dedupKey).toBe(plain.dedupKey)
    expect(punctuated.dedupKey).not.toBe(plain.dedupKey)
    expect(dispatches).toBe(2)
  })
})
