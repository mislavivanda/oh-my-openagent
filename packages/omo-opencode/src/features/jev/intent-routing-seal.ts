// allow: SIZE_OK - Per-session logical seal and deferred finalization transitions are one atomic controller.

import {
  type IntentRoutingCorrelationStatus,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
  type IntentRoutingObservationRecord,
  type IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

import {
  isRealUserTextPart,
  isSyntheticOrInternalOnlyTextParts,
  type InternalInitiatorTextPartLike,
} from "../../shared"
import {
  createIntentRoutingTurnStore,
  normalizeIntentRoutingPrompt,
  type IntentRoutingDispatchedTurnInput,
  type IntentRoutingNotDispatchedTurnInput,
  type IntentRoutingScheduleTimeout,
  type IntentRoutingTimeoutHandle,
  type IntentRoutingTurnRecord,
  type IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-store"
import {
  materializeIntentRoutingObservation,
  type IntentRoutingSealTurnMetadata,
} from "./intent-routing-seal-record"

export type IntentRoutingSealSink = {
  readonly processId: string
  readonly append: (entry: IntentRoutingEntry) => boolean | Promise<boolean>
  readonly updateCounters: (counters: IntentRoutingCounters) => void
  readonly getCounterEpoch: () => number
  readonly dispose: () => void
}
export type IntentRoutingSealMessageInput =
  | (Omit<IntentRoutingDispatchedTurnInput, "textParts"> & {
    readonly parts: readonly InternalInitiatorTextPartLike[]
  })
  | (Omit<IntentRoutingNotDispatchedTurnInput, "textParts"> & {
    readonly parts: readonly InternalInitiatorTextPartLike[]
  })
export type IntentRoutingSealControllerOptions = {
  readonly sink: IntentRoutingSealSink
  readonly turnSealTimeoutMs: number
  readonly maxPromptChars?: number
  readonly now?: () => Date
  readonly scheduleSealTimeout?: IntentRoutingScheduleTimeout
  readonly scheduleFlushTimeout?: IntentRoutingScheduleTimeout
  readonly disposeFlushTimeoutMs?: number
  readonly storeOptions?: Omit<
    IntentRoutingTurnStoreOptions,
    "onCounterDelta" | "onFinalize" | "processId" | "counterEpoch"
  >
}
export type IntentRoutingSealController = {
  readonly onMessage: (input: IntentRoutingSealMessageInput) => IntentRoutingTurnRecord | null
  readonly appendObservation: (input: {
    readonly sessionID: string
    readonly observation: IntentRoutingObservedDelegation
  }) => boolean
  readonly onSessionIdle: (sessionID: string) => boolean
  readonly onSessionDeleted: (sessionID: string) => void
  readonly getTurn: (sessionID: string, turnOrdinal: number) => IntentRoutingTurnRecord | undefined
  readonly listTurns: (sessionID: string) => readonly IntentRoutingTurnRecord[]
  readonly getCounters: () => IntentRoutingCounters
  readonly dispose: () => Promise<void>
}

type SessionWindow = {
  readonly activeOrdinal: number
  readonly predecessorOrdinal: number | null
  readonly timeout: IntentRoutingTimeoutHandle
}

function defaultScheduleTimeout(callback: () => void, delayMs: number): IntentRoutingTimeoutHandle {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return { cancel: () => clearTimeout(timer) }
}

export function isIntentRoutingHeadlineEligible(record: {
  readonly correlationStatus: IntentRoutingCorrelationStatus
}): boolean {
  return record.correlationStatus === "reliable"
}

export function createIntentRoutingSealController(
  options: IntentRoutingSealControllerOptions,
): IntentRoutingSealController {
  const now = options.now ?? (() => new Date())
  const scheduleSealTimeout = options.scheduleSealTimeout ?? defaultScheduleTimeout
  const scheduleFlushTimeout = options.scheduleFlushTimeout ?? defaultScheduleTimeout
  const disposeFlushTimeoutMs = options.disposeFlushTimeoutMs ?? 1_000
  const maxPromptChars = options.maxPromptChars ?? 8_000
  const metadata = new Map<string, Map<number, IntentRoutingSealTurnMetadata>>()
  const windows = new Map<string, SessionWindow>()
  const pendingWrites = new Set<Promise<void>>()
  let disposePromise: Promise<void> | null = null

  const queueEntry = (entry: IntentRoutingEntry): void => {
    try {
      const result = options.sink.append(entry)
      if (typeof result === "boolean") return
      const pending = result.then(() => undefined, () => undefined)
      pendingWrites.add(pending)
      void pending.finally(() => pendingWrites.delete(pending))
    } catch (error) {
      if (error instanceof Error) void error.message
      else void String(error)
    }
  }
  const store = createIntentRoutingTurnStore({
    ...options.storeOptions,
    now: options.storeOptions?.now ?? (() => now().getTime()),
    processId: options.sink.processId,
    counterEpoch: options.sink.getCounterEpoch(),
    onCounterDelta: (entry) => {
      options.sink.updateCounters(entry.counters)
      queueEntry(entry)
    },
    onFinalize: (turn) => {
      const turnMetadata = metadata.get(turn.sessionID)?.get(turn.turnOrdinal)
      if (!turnMetadata) return
      const entry = materializeIntentRoutingObservation({
        turn,
        metadata: turnMetadata,
        recordedAt: now().toISOString(),
        counterEpoch: options.sink.getCounterEpoch(),
      })
      if (entry) queueEntry(entry)
      metadata.get(turn.sessionID)?.delete(turn.turnOrdinal)
    },
  })

  const sealActive = (sessionID: string, sealedBy: "session_idle" | "seal_timeout"): boolean => {
    const window = windows.get(sessionID)
    if (!window) return false
    window.timeout.cancel()
    const sealed = store.sealTurn({
      sessionID,
      turnOrdinal: window.activeOrdinal,
      sealedBy,
      deferFinalization: true,
    })
    windows.delete(sessionID)
    if (!sealed) return false
    if (window.predecessorOrdinal !== null) {
      store.finalizeTurn({ sessionID, turnOrdinal: window.predecessorOrdinal })
    }
    store.finalizeTurn({ sessionID, turnOrdinal: window.activeOrdinal })
    return true
  }
  const scheduleWindow = (
    sessionID: string,
    activeOrdinal: number,
    predecessorOrdinal: number | null,
  ): void => {
    const timeout = scheduleSealTimeout(() => {
      const current = windows.get(sessionID)
      if (current?.activeOrdinal === activeOrdinal) sealActive(sessionID, "seal_timeout")
    }, options.turnSealTimeoutMs)
    windows.set(sessionID, { activeOrdinal, predecessorOrdinal, timeout })
  }
  const waitForWrites = async (): Promise<void> => {
    if (pendingWrites.size === 0) return
    await new Promise<void>((resolve) => {
      let settled = false
      let timeout: IntentRoutingTimeoutHandle | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        timeout?.cancel()
        resolve()
      }
      timeout = scheduleFlushTimeout(finish, disposeFlushTimeoutMs)
      void Promise.allSettled([...pendingWrites]).then(finish)
    })
  }

  return {
    onMessage: (input) => {
      if (isSyntheticOrInternalOnlyTextParts(input.parts)) {
        store.recordSyntheticTurn()
        return null
      }
      const textParts = input.parts.filter(isRealUserTextPart).map(({ text }) => text)
      const turnInput = input.dispatch
        ? { ...input, textParts, dispatch: input.dispatch }
        : { ...input, textParts, notDispatchedReason: input.notDispatchedReason }
      const previous = windows.get(input.sessionID)
      const turn = store.createTurn(turnInput)
      const sessionMetadata = metadata.get(input.sessionID) ??
        new Map<number, IntentRoutingSealTurnMetadata>()
      sessionMetadata.set(turn.turnOrdinal, {
        questionVersion: input.questionVersion,
        normalizedPrompt: normalizeIntentRoutingPrompt(textParts),
      })
      metadata.set(input.sessionID, sessionMetadata)
      previous?.timeout.cancel()
      const predecessorOrdinal = previous?.activeOrdinal ?? null
      if (previous) {
        store.sealTurn({
          sessionID: input.sessionID,
          turnOrdinal: previous.activeOrdinal,
          sealedBy: "next_turn",
          deferFinalization: true,
        })
        if (previous.predecessorOrdinal !== null) {
          store.finalizeTurn({ sessionID: input.sessionID, turnOrdinal: previous.predecessorOrdinal })
        }
      }
      scheduleWindow(input.sessionID, turn.turnOrdinal, predecessorOrdinal)
      const retained = new Set(store.listTurns(input.sessionID).map(({ turnOrdinal }) => turnOrdinal))
      for (const ordinal of sessionMetadata.keys()) if (!retained.has(ordinal)) sessionMetadata.delete(ordinal)
      return store.getTurn(input.sessionID, turn.turnOrdinal) ?? turn
    },
    appendObservation: (input) => {
      const attached = store.appendObservation(input)
      const window = windows.get(input.sessionID)
      if (attached && window?.predecessorOrdinal !== null && window?.predecessorOrdinal !== undefined) {
        store.markOverlap({
          sessionID: input.sessionID,
          predecessorOrdinal: window.predecessorOrdinal,
          successorOrdinal: window.activeOrdinal,
        })
      }
      return attached
    },
    onSessionIdle: (sessionID) => sealActive(sessionID, "session_idle"),
    onSessionDeleted: (sessionID) => {
      windows.get(sessionID)?.timeout.cancel()
      windows.delete(sessionID)
      store.deleteSession(sessionID)
      metadata.delete(sessionID)
    },
    getTurn: store.getTurn,
    listTurns: store.listTurns,
    getCounters: store.getCounters,
    dispose: () => {
      if (disposePromise) return disposePromise
      disposePromise = (async () => {
        for (const window of windows.values()) window.timeout.cancel()
        windows.clear()
        store.dispose()
        options.sink.updateCounters(store.getCounters())
        await waitForWrites()
        options.sink.dispose()
        metadata.clear()
      })()
      return disposePromise
    },
  }
}
