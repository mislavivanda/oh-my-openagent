import type {
  DecisionUnavailableReason,
  IntentRoutingAnswers,
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

export type IntentRoutingTextPart = Readonly<{
  type?: string
  text?: string
  synthetic?: boolean
}>

export type TerminalPredictionStatus = IntentRoutingObservationRecord["predictionStatus"]
export type CorrelationStatus = IntentRoutingObservationRecord["correlationStatus"]
export type SealedBy = IntentRoutingObservationRecord["sealedBy"]

export type IntentRoutingTurnState =
  | "created"
  | "prediction_filled"
  | "prediction_failed"
  | "prediction_timeout"
  | "not_dispatched"
  | "sealed"
  | "evicted"

export type IntentRoutingTurnInput = Readonly<{
  sessionID: string
  parts: readonly IntentRoutingTextPart[]
  questionVersion: number
  vocabularyDigest: string
  confidenceThreshold: number
  configuredModelSpec: string
  currentResolvedModel?: string | undefined
  predictionTimeoutMs: number
  truncatedInput: boolean
  dispatch?: (() => Promise<IntentRoutingDecisionResult>) | undefined
  notDispatchedReason?: string | undefined
}>

export type IntentRoutingTurnSnapshot = Readonly<{
  state: IntentRoutingTurnState
  sessionID: string
  turnOrdinal: number
  dedupKey: string
  reuseKey: string
  predictionStatus: "pending" | TerminalPredictionStatus
  predictionReused: boolean
  resolvedModel: string | null
  answers: IntentRoutingAnswers | null
  observed: readonly IntentRoutingObservedDelegation[]
  sealedBy: SealedBy | null
  correlationStatus: CorrelationStatus | null
  correlationWindowClosed: boolean
  finalized: boolean
}>

export type IntentRoutingTurnStoreOptions = Readonly<{
  maxTrackedSessions: number
  maxTurnsPerSession: number
  sink: (entry: IntentRoutingEntry) => void
  processId: string
  schemaVersion?: number
  counterEpoch?: number
  now?: () => Date
}>

export type LiveIntentRoutingTurn = {
  state: IntentRoutingTurnState
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  reuseKey: string
  readonly prompt: string
  readonly promptHash: string
  readonly questionVersion: number
  readonly truncatedInput: boolean
  predictionStatus: "pending" | TerminalPredictionStatus
  predictionReused: boolean
  notDispatchedReason: string | null
  unavailableReason: DecisionUnavailableReason | null
  resolvedModel: string | null
  latencyMs: number
  answers: IntentRoutingAnswers | null
  invalidAnswerCount: number
  readonly observed: IntentRoutingObservedDelegation[]
  sealedBy: SealedBy | null
  correlationStatus: CorrelationStatus | null
  correlationWindowClosed: boolean
  finalized: boolean
}

export type IntentRoutingSessionState = {
  readonly turns: Map<number, LiveIntentRoutingTurn>
  nextOrdinal: number
}
