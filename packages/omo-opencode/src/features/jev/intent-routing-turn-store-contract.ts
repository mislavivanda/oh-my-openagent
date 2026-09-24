import type {
  IntentRoutingCorrelationStatus,
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingDecisionAnswers,
  IntentRoutingDecisionResult,
  IntentRoutingObservedDelegation,
  IntentRoutingPredictionStatus,
  IntentRoutingSealedBy,
} from "@oh-my-opencode/jev-core"

export type IntentRoutingTurnState = "created" | "prediction_filled" | "prediction_failed" |
  "prediction_timeout" | "not_dispatched" | "sealed" | "evicted"

export type IntentRoutingTurnRecord = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly preDispatchKey: string
  readonly reuseKey: string
  readonly predictionReused: boolean
  readonly state: IntentRoutingTurnState
  readonly predictionStatus: IntentRoutingPredictionStatus | "pending"
  readonly notDispatchedReason: string | null
  readonly answers: IntentRoutingDecisionAnswers | null
  readonly invalidAnswerCount: number
  readonly unavailableReason: IntentRoutingDecisionResult["unavailableReason"]
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly truncatedInput: boolean
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly sealedBy: IntentRoutingSealedBy | null
  readonly correlationStatus: IntentRoutingCorrelationStatus | null
  readonly awaitingFinalization: boolean
}

type IntentRoutingTurnIdentity = {
  readonly sessionID: string
  readonly textParts: readonly string[]
  readonly questionVersion: number
  readonly vocabularyDigest: string
  readonly confidenceThreshold: number
  readonly configuredModelSpec: string
  readonly knownResolvedModel?: string
}

export type IntentRoutingDispatchedTurnInput = IntentRoutingTurnIdentity & {
  readonly dispatch: () => Promise<IntentRoutingDecisionResult>
  readonly notDispatchedReason?: never
}

export type IntentRoutingNotDispatchedTurnInput = IntentRoutingTurnIdentity & {
  readonly dispatch?: never
  readonly notDispatchedReason: string
}

export type IntentRoutingTurnInput = IntentRoutingDispatchedTurnInput | IntentRoutingNotDispatchedTurnInput
export type IntentRoutingTimeoutHandle = { readonly cancel: () => void }
export type IntentRoutingScheduleTimeout = (
  callback: () => void,
  delayMs: number,
) => IntentRoutingTimeoutHandle

export type IntentRoutingSealInput = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly sealedBy: IntentRoutingSealedBy
  readonly deferFinalization?: boolean
}

export type IntentRoutingTurnStoreOptions = {
  readonly maxTrackedSessions?: number
  readonly maxTurnsPerSession?: number
  readonly predictionTimeoutMs?: number
  readonly processId?: string
  readonly counterEpoch?: number
  readonly now?: () => number
  readonly scheduleTimeout?: IntentRoutingScheduleTimeout
  readonly onCounterDelta?: (entry: IntentRoutingCounterDelta) => void
  readonly onFinalize?: (record: IntentRoutingTurnRecord) => void
}

export type IntentRoutingTurnStore = {
  readonly createTurn: (input: IntentRoutingTurnInput) => IntentRoutingTurnRecord
  readonly appendObservation: (input: {
    readonly sessionID: string
    readonly observation: IntentRoutingObservedDelegation
  }) => boolean
  readonly getTurn: (sessionID: string, turnOrdinal: number) => IntentRoutingTurnRecord | undefined
  readonly listTurns: (sessionID: string) => readonly IntentRoutingTurnRecord[]
  readonly sealTurn: (input: IntentRoutingSealInput) => boolean
  readonly markOverlap: (input: {
    readonly sessionID: string
    readonly predecessorOrdinal: number
    readonly successorOrdinal: number
  }) => boolean
  readonly finalizeTurn: (input: { readonly sessionID: string; readonly turnOrdinal: number }) => boolean
  readonly recordSyntheticTurn: () => void
  readonly recordDispatchDropped: () => void
  readonly deleteSession: (sessionID: string) => void
  readonly getCounters: () => IntentRoutingCounters
  readonly getMapSizes: () => { readonly sessions: number; readonly reuseSessions: number }
  readonly dispose: () => void
}
