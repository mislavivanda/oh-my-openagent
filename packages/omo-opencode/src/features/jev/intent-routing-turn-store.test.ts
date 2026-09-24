import { describe, expect, test } from "bun:test"

import type {
  IntentRoutingCounterDelta,
  IntentRoutingDecisionResult,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

import {
  createIntentRoutingPromptHash,
  createIntentRoutingTurnStore,
  normalizeIntentRoutingPrompt,
  type IntentRoutingDispatchedTurnInput,
  type IntentRoutingScheduleTimeout,
} from "./intent-routing-turn-store"

const FILLED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "filled",
  truncatedInput: false,
  answers: {
    intent: { choice: "delegate", confidence: 0.95, probabilities: { delegate: 0.95, none: 0.05 }, valid: true, label: "would_apply" },
    category: { choice: "deep", confidence: 0.9, probabilities: { deep: 0.9, none: 0.1 }, valid: true, label: "would_apply" },
    subagent: { choice: "explore", confidence: 0.85, probabilities: { explore: 0.85, none: 0.15 }, valid: true, label: "would_apply" },
    ambiguous: { noul: 0.1, valid: true },
  },
  invalidAnswerCount: 0,
  unavailableReason: null,
  resolvedModel: "jev-2026-09-24",
  latencyMs: 11,
  threshold: 0.8,
  questionVersion: 1,
}

const FAILED_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "failed",
  truncatedInput: false,
  answers: null,
  invalidAnswerCount: 0,
  unavailableReason: "transport_error",
  resolvedModel: null,
  latencyMs: null,
  threshold: 0.8,
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

const BASE_INPUT = {
  sessionID: "session-1",
  textParts: ["continue"],
  questionVersion: 1,
  vocabularyDigest: "vocab-1",
  confidenceThreshold: 0.8,
  configuredModelSpec: "jev-2026-09-24",
} as const

function dispatchedInput(
  dispatch: () => Promise<IntentRoutingDecisionResult>,
  overrides: Partial<Omit<IntentRoutingDispatchedTurnInput, "dispatch">> = {},
): IntentRoutingDispatchedTurnInput {
  return { ...BASE_INPUT, ...overrides, dispatch }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function manualScheduler(): {
  readonly schedule: IntentRoutingScheduleTimeout
  readonly fireNext: () => void
} {
  const callbacks: Array<{ callback: () => void; cancelled: boolean }> = []
  return {
    schedule: (callback) => {
      const entry = { callback, cancelled: false }
      callbacks.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    fireNext: () => {
      const entry = callbacks.find((candidate) => !candidate.cancelled)
      entry?.callback()
    },
  }
}

async function flushPredictions(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("intent-routing turn store", () => {
  test("#given the same prompt twice #when creating turns #then locally minted ordinals stay distinct from the dedup key", () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const store = createIntentRoutingTurnStore()

    const first = store.createTurn(dispatchedInput(() => pending.promise))
    const second = store.createTurn(dispatchedInput(() => pending.promise))

    expect(first.dedupKey).toBe(second.dedupKey)
    expect(first.turnOrdinal).not.toBe(second.turnOrdinal)
  })

  test("#given a pending predecessor #when an identical turn arrives #then one dispatch fills both ordinals without resolvedModel in tier one", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    let dispatches = 0
    const store = createIntentRoutingTurnStore()
    const dispatch = () => { dispatches += 1; return pending.promise }

    const first = store.createTurn(dispatchedInput(dispatch, { configuredModelSpec: "jev-latest" }))
    const second = store.createTurn(dispatchedInput(dispatch, { configuredModelSpec: "jev-latest" }))
    expect(dispatches).toBe(1)
    expect(first.preDispatchKey).toBe(second.preDispatchKey)
    expect(first.preDispatchKey).not.toContain(FILLED_RESULT.resolvedModel)

    pending.resolve(FILLED_RESULT)
    await flushPredictions()
    const completedFirst = store.getTurn("session-1", first.turnOrdinal)
    const completedSecond = store.getTurn("session-1", second.turnOrdinal)
    expect(completedFirst?.state).toBe("prediction_filled")
    expect(completedSecond?.state).toBe("prediction_filled")
    expect(completedSecond?.predictionReused).toBe(true)
    expect(completedFirst?.answers).toEqual(completedSecond?.answers)
    expect(completedFirst?.answers).not.toBe(completedSecond?.answers)
  })

  test("#given a filled predecessor using a pinned model #when the prompt repeats #then tier-two answers are copied", async () => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    const store = createIntentRoutingTurnStore()
    store.createTurn(dispatchedInput(dispatch))
    await flushPredictions()

    const reused = store.createTurn(dispatchedInput(dispatch))

    expect(dispatches).toBe(1)
    expect(reused.state).toBe("prediction_filled")
    expect(reused.predictionReused).toBe(true)
    expect(reused.reuseKey).toContain("jev-2026-09-24")
  })

  test("#given a filled predecessor using a floating alias #when current resolution is unknown #then completed reuse is disabled", async () => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    const store = createIntentRoutingTurnStore()
    const floating = { configuredModelSpec: "jev-latest" }
    store.createTurn(dispatchedInput(dispatch, floating))
    await flushPredictions()

    const fresh = store.createTurn(dispatchedInput(dispatch, floating))

    expect(dispatches).toBe(2)
    expect(fresh.predictionReused).toBe(false)
  })

  test("#given a floating alias with an independently known resolution #when the prompt repeats #then completed reuse is allowed", async () => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    const store = createIntentRoutingTurnStore()
    const known = { configuredModelSpec: "jev-latest", knownResolvedModel: "jev-2026-09-24" }
    store.createTurn(dispatchedInput(dispatch, known))
    await flushPredictions()

    const reused = store.createTurn(dispatchedInput(dispatch, known))

    expect(dispatches).toBe(1)
    expect(reused.predictionReused).toBe(true)
  })

  test("#given a failed predecessor #when the prompt repeats #then a fresh prediction is dispatched", async () => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FAILED_RESULT }
    const store = createIntentRoutingTurnStore()
    store.createTurn(dispatchedInput(dispatch))
    await flushPredictions()

    const fresh = store.createTurn(dispatchedInput(dispatch))

    expect(dispatches).toBe(2)
    expect(fresh.predictionReused).toBe(false)
  })

  test("#given a timed-out predecessor #when the prompt repeats #then a fresh prediction is dispatched", () => {
    const scheduler = manualScheduler()
    const pending = deferred<IntentRoutingDecisionResult>()
    let dispatches = 0
    const dispatch = () => { dispatches += 1; return pending.promise }
    const store = createIntentRoutingTurnStore({ scheduleTimeout: scheduler.schedule })
    store.createTurn(dispatchedInput(dispatch))
    scheduler.fireNext()

    const fresh = store.createTurn(dispatchedInput(dispatch))

    expect(dispatches).toBe(2)
    expect(fresh.predictionReused).toBe(false)
  })

  test("#given a not-dispatched predecessor #when the prompt repeats #then a fresh prediction is dispatched", () => {
    let dispatches = 0
    const store = createIntentRoutingTurnStore()
    store.createTurn({ ...BASE_INPUT, notDispatchedReason: "not-main-session" })

    const fresh = store.createTurn(dispatchedInput(async () => { dispatches += 1; return FILLED_RESULT }))

    expect(dispatches).toBe(1)
    expect(fresh.predictionReused).toBe(false)
  })

  test("#given an evicted predecessor #when its prompt repeats #then a fresh prediction is dispatched", async () => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    const store = createIntentRoutingTurnStore({ maxTurnsPerSession: 1 })
    store.createTurn(dispatchedInput(dispatch))
    await flushPredictions()
    store.createTurn(dispatchedInput(dispatch, { textParts: ["different"] }))
    await flushPredictions()

    const fresh = store.createTurn(dispatchedInput(dispatch))

    expect(dispatches).toBe(3)
    expect(fresh.predictionReused).toBe(false)
  })

  test.each([
    ["questionVersion", { questionVersion: 2 }],
    ["vocabularyDigest", { vocabularyDigest: "vocab-2" }],
    ["confidenceThreshold", { confidenceThreshold: 0.9 }],
    ["configuredModelSpec", { configuredModelSpec: "jev-2026-09-25" }],
  ] as const)("#given a completed turn #when %s changes #then tier one differs and dispatches fresh", async (_field, changes) => {
    let dispatches = 0
    const dispatch = async () => { dispatches += 1; return FILLED_RESULT }
    const store = createIntentRoutingTurnStore()
    const first = store.createTurn(dispatchedInput(dispatch))
    await flushPredictions()

    const second = store.createTurn(dispatchedInput(dispatch, changes))

    expect(second.preDispatchKey).not.toBe(first.preDispatchKey)
    expect(dispatches).toBe(2)
  })

  test("#given an observation on a pending turn #when prediction resolves #then the observation is retained", async () => {
    const pending = deferred<IntentRoutingDecisionResult>()
    const store = createIntentRoutingTurnStore()
    const turn = store.createTurn(dispatchedInput(() => pending.promise))
    expect(store.appendObservation({ sessionID: "session-1", observation: OBSERVATION })).toBe(true)

    pending.resolve(FILLED_RESULT)
    await flushPredictions()

    expect(store.getTurn("session-1", turn.turnOrdinal)?.observed).toEqual([OBSERVATION])
  })

  test("#given a bounded session #when max plus five turns are created #then five LRU turns are counted and only newest survive", () => {
    const emitted: IntentRoutingCounterDelta[] = []
    const store = createIntentRoutingTurnStore({
      maxTurnsPerSession: 3,
      onCounterDelta: (entry) => emitted.push(entry),
    })
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      store.createTurn({ ...BASE_INPUT, textParts: [`turn ${ordinal}`], notDispatchedReason: "gated" })
    }

    expect(store.getCounters().recordsEvicted).toBe(5)
    expect(emitted).toHaveLength(5)
    expect(emitted.every((entry) => entry.kind === "counter_delta")).toBe(true)
    expect(store.listTurns("session-1").map((record) => record.turnOrdinal)).toEqual([6, 7, 8])
  })

  test("#given pending state and reuse maps #when session.deleted is handled #then pending becomes timeout, records seal, and both maps clear", () => {
    const finalized: Array<{ state: string; predictionStatus: string; sealedBy: string | null }> = []
    const pending = deferred<IntentRoutingDecisionResult>()
    const store = createIntentRoutingTurnStore({
      onFinalize: (record) => finalized.push({
        state: record.state,
        predictionStatus: record.predictionStatus,
        sealedBy: record.sealedBy,
      }),
    })
    store.createTurn(dispatchedInput(() => pending.promise))
    expect(store.getMapSizes()).toEqual({ sessions: 1, reuseSessions: 1 })

    store.deleteSession("session-1")

    expect(store.getMapSizes()).toEqual({ sessions: 0, reuseSessions: 0 })
    expect(finalized).toEqual([{ state: "sealed", predictionStatus: "timeout", sealedBy: "session_deleted" }])
  })

  test("#given a never-resolving prediction #when its timeout fires #then the turn becomes prediction_timeout", () => {
    const scheduler = manualScheduler()
    const pending = deferred<IntentRoutingDecisionResult>()
    const store = createIntentRoutingTurnStore({ scheduleTimeout: scheduler.schedule })
    const turn = store.createTurn(dispatchedInput(() => pending.promise))

    scheduler.fireNext()

    expect(store.getTurn("session-1", turn.turnOrdinal)?.state).toBe("prediction_timeout")
    expect(store.getTurn("session-1", turn.turnOrdinal)?.predictionStatus).toBe("timeout")
  })

  test("#given whitespace, case, reminders, and punctuation #when prompts are normalized #then only the specified equivalents collide", () => {
    expect(normalizeIntentRoutingPrompt(["<system-reminder>ignore</system-reminder>  Continue  "])).toBe("continue")
    expect(createIntentRoutingPromptHash(["  Continue  "])).toBe(createIntentRoutingPromptHash(["continue"]))
    expect(createIntentRoutingPromptHash(["continue!"])).not.toBe(createIntentRoutingPromptHash(["continue"]))
  })
})
