import type {
  IntentRoutingCounters,
  IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"
import { isSyntheticOrInternalOnlyTextParts } from "../../shared"
import { emptyIntentRoutingCounters } from "./intent-routing-sink-counters"
import { createIntentRoutingTurnStore } from "./intent-routing-turn-store"
import type {
  IntentRoutingStartTurnInput,
  IntentRoutingTurnHandle,
  IntentRoutingTurnStore,
  IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-types"

export const DEFAULT_INTENT_ROUTING_DISPOSE_FLUSH_TIMEOUT_MS = 250

export type IntentRoutingSealSink = {
  readonly processId?: string
  append(entry: IntentRoutingEntry): boolean | Promise<boolean>
  dispose(): void | Promise<void>
}

export type IntentRoutingSealCoordinatorOptions = {
  readonly turnSealTimeoutMs: number
  readonly disposeFlushTimeoutMs?: number
  readonly turnStoreOptions?: Omit<IntentRoutingTurnStoreOptions, "onEntry" | "processId">
  readonly createSink: (getCounters: () => IntentRoutingCounters) => IntentRoutingSealSink
}

export type IntentRoutingSealCoordinator = {
  readonly store: IntentRoutingTurnStore
  startTurn(input: IntentRoutingStartTurnInput): IntentRoutingTurnHandle | null
  sealSessionIdle(sessionID: string): boolean
  deleteSession(sessionID: string): void
  dispose(): Promise<void>
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function timerKey(sessionID: string, turnOrdinal: number): string {
  return JSON.stringify([sessionID, turnOrdinal])
}

export function createIntentRoutingSealCoordinator(
  options: IntentRoutingSealCoordinatorOptions,
): IntentRoutingSealCoordinator {
  const sealTimeoutMs = positiveMilliseconds(options.turnSealTimeoutMs, 120_000)
  const flushTimeoutMs = positiveMilliseconds(
    options.disposeFlushTimeoutMs,
    DEFAULT_INTENT_ROUTING_DISPOSE_FLUSH_TIMEOUT_MS,
  )
  const pendingWrites = new Set<Promise<void>>()
  const sealTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let readCounters = (): IntentRoutingCounters => emptyIntentRoutingCounters()
  const sink = options.createSink(() => readCounters())

  function trackWrite(result: boolean | void | Promise<boolean | void>): void {
    if (!(result instanceof Promise)) return
    let tracked: Promise<void>
    tracked = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => pendingWrites.delete(tracked))
    pendingWrites.add(tracked)
  }

  const store = createIntentRoutingTurnStore({
    ...options.turnStoreOptions,
    ...(sink.processId === undefined ? {} : { processId: sink.processId }),
    onEntry: (entry) => trackWrite(sink.append(entry)),
  })
  readCounters = store.getCounters
  let disposed = false
  let disposePromise: Promise<void> | undefined

  function clearSealTimer(sessionID: string, turnOrdinal: number): void {
    const key = timerKey(sessionID, turnOrdinal)
    const timer = sealTimers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    sealTimers.delete(key)
  }

  function finalizePredecessors(sessionID: string, successorOrdinal: number): void {
    const predecessors = store.getSessionTurns(sessionID).filter((turn) => (
      turn.turnOrdinal < successorOrdinal
      && turn.terminalState === "sealed"
      && turn.deferredFinalization
    ))
    for (const predecessor of predecessors) {
      store.finalizeTurn(sessionID, predecessor.turnOrdinal)
    }
  }

  function sealTurn(
    sessionID: string,
    turnOrdinal: number,
    sealedBy: "next_turn" | "session_idle" | "seal_timeout",
  ): boolean {
    clearSealTimer(sessionID, turnOrdinal)
    const sealed = store.sealTurn({
      sessionID,
      turnOrdinal,
      sealedBy,
      deferFinalization: sealedBy === "next_turn",
    })
    if (!sealed) return false
    finalizePredecessors(sessionID, turnOrdinal)
    return true
  }

  function scheduleSealTimeout(turn: IntentRoutingTurnHandle): void {
    const key = timerKey(turn.sessionID, turn.turnOrdinal)
    const timer = setTimeout(() => {
      sealTimers.delete(key)
      sealTurn(turn.sessionID, turn.turnOrdinal, "seal_timeout")
    }, sealTimeoutMs)
    timer.unref?.()
    sealTimers.set(key, timer)
  }

  function startTurn(input: IntentRoutingStartTurnInput): IntentRoutingTurnHandle | null {
    if (disposed || isSyntheticOrInternalOnlyTextParts(input.parts)) return null
    const predecessor = store.getSessionTurns(input.sessionID ?? "")
      .findLast((turn) => turn.terminalState === "live")
    const successor = store.startTurn(input)
    if (successor === null) return null
    scheduleSealTimeout(successor)
    if (predecessor !== undefined) {
      sealTurn(predecessor.sessionID, predecessor.turnOrdinal, "next_turn")
    }
    return successor
  }

  function sealSessionIdle(sessionID: string): boolean {
    let sealed = false
    const liveTurns = store.getSessionTurns(sessionID).filter((turn) => turn.terminalState === "live")
    for (const turn of liveTurns) {
      sealed = sealTurn(sessionID, turn.turnOrdinal, "session_idle") || sealed
    }
    return sealed
  }

  function deleteSession(sessionID: string): void {
    for (const turn of store.getSessionTurns(sessionID)) {
      clearSealTimer(sessionID, turn.turnOrdinal)
    }
    store.deleteSession(sessionID)
  }

  async function awaitPendingWrites(): Promise<void> {
    if (pendingWrites.size === 0) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, flushTimeoutMs)
    })
    await Promise.race([Promise.all([...pendingWrites]).then(() => undefined), bounded])
    if (timeout !== undefined) clearTimeout(timeout)
  }

  async function disposeOnce(): Promise<void> {
    disposed = true
    for (const timer of sealTimers.values()) clearTimeout(timer)
    sealTimers.clear()
    store.dispose()
    await awaitPendingWrites()
    trackWrite(sink.dispose())
    await awaitPendingWrites()
  }

  return {
    store,
    startTurn,
    sealSessionIdle,
    deleteSession,
    dispose: async () => {
      disposePromise ??= disposeOnce()
      await disposePromise
    },
  }
}
