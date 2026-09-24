import type {
  IntentRoutingEntry,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"
import { isSyntheticOrInternalOnlyTextParts } from "../../shared"
import {
  createIntentRoutingTurnStore,
  type IntentRoutingTurnInput,
  type IntentRoutingTurnSnapshot,
  type IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-store"

const DEFAULT_DISPOSE_FLUSH_TIMEOUT_MS = 1_000

type ScheduledTask = Readonly<{ cancel(): void }>
type Schedule = (run: () => void, delayMs: number) => ScheduledTask

export type IntentRoutingSealOptions = Omit<IntentRoutingTurnStoreOptions, "sink"> & Readonly<{
  sink: (entry: IntentRoutingEntry) => unknown
  turnSealTimeoutMs: number
  disposeFlushTimeoutMs?: number
  disposeSink?: (() => unknown) | undefined
  schedule?: Schedule
}>

export type IntentRoutingSeal = Readonly<{
  handleMessage(input: IntentRoutingTurnInput): IntentRoutingTurnSnapshot | undefined
  appendObservation(sessionID: string, observation: IntentRoutingObservedDelegation): boolean
  handleSessionIdle(sessionID: string): void
  handleSessionDeleted(sessionID: string): void
  getTurn(sessionID: string, turnOrdinal: number): IntentRoutingTurnSnapshot | undefined
  listTurns(sessionID: string): readonly IntentRoutingTurnSnapshot[]
  dispose(): Promise<void>
}>

function scheduleTask(run: () => void, delayMs: number): ScheduledTask {
  const timer = setTimeout(run, delayMs)
  timer.unref()
  return { cancel: () => clearTimeout(timer) }
}

export function createIntentRoutingSeal(options: IntentRoutingSealOptions): IntentRoutingSeal {
  if (options.turnSealTimeoutMs < 1) throw new RangeError("Intent-routing seal timeout must be positive")
  const schedule = options.schedule ?? scheduleTask
  const flushTimeoutMs = options.disposeFlushTimeoutMs ?? DEFAULT_DISPOSE_FLUSH_TIMEOUT_MS
  const pendingWrites = new Set<Promise<unknown>>()
  const timers = new Map<string, ScheduledTask>()
  let disposed = false

  const store = createIntentRoutingTurnStore({
    ...options,
    sink(entry) {
      const result = options.sink(entry)
      if (!(result instanceof Promise)) return
      pendingWrites.add(result)
      void result.then(
        () => pendingWrites.delete(result),
        () => pendingWrites.delete(result),
      )
    },
  })

  const timerKey = (sessionID: string, turnOrdinal: number): string => `${sessionID}:${turnOrdinal}`

  function cancelTimer(sessionID: string, turnOrdinal: number): void {
    const key = timerKey(sessionID, turnOrdinal)
    timers.get(key)?.cancel()
    timers.delete(key)
  }

  function cancelSessionTimers(sessionID: string): void {
    for (const turn of store.listTurns(sessionID)) cancelTimer(sessionID, turn.turnOrdinal)
  }

  function scheduleSeal(turn: IntentRoutingTurnSnapshot): void {
    const key = timerKey(turn.sessionID, turn.turnOrdinal)
    const task = schedule(() => {
      timers.delete(key)
      store.sealTurn(turn.sessionID, turn.turnOrdinal, "seal_timeout")
    }, options.turnSealTimeoutMs)
    timers.set(key, task)
  }

  async function awaitBounded(promise: Promise<unknown>): Promise<void> {
    let timeout: ScheduledTask | undefined
    const settled = promise.then(() => undefined, () => undefined)
    const elapsed = new Promise<void>((resolve) => {
      timeout = schedule(resolve, flushTimeoutMs)
    })
    await Promise.race([settled, elapsed])
    timeout?.cancel()
  }

  return {
    handleMessage(input) {
      if (isSyntheticOrInternalOnlyTextParts(input.parts)) return undefined
      const predecessor = store.listTurns(input.sessionID).at(-1)
      const successor = store.createTurn(input)
      scheduleSeal(successor)
      if (predecessor !== undefined && predecessor.sealedBy === null) {
        cancelTimer(predecessor.sessionID, predecessor.turnOrdinal)
        store.sealTurn(predecessor.sessionID, predecessor.turnOrdinal, "next_turn")
      }
      return successor
    },
    appendObservation: store.appendObservation,
    handleSessionIdle(sessionID) {
      cancelSessionTimers(sessionID)
      store.sealSessionIdle(sessionID)
    },
    handleSessionDeleted(sessionID) {
      cancelSessionTimers(sessionID)
      store.deleteSession(sessionID)
    },
    getTurn: store.getTurn,
    listTurns: store.listTurns,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
      store.dispose()
      await awaitBounded(Promise.allSettled([...pendingWrites]))
      const disposeResult = options.disposeSink?.()
      if (disposeResult instanceof Promise) await awaitBounded(disposeResult)
    },
  }
}
