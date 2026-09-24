import type {
  IntentRoutingAnswers,
  IntentRoutingCounters,
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

export const DEFAULT_INTENT_ROUTING_MAX_TRACKED_SESSIONS = 256
export const DEFAULT_INTENT_ROUTING_MAX_TURNS_PER_SESSION = 128
export const DEFAULT_INTENT_ROUTING_PREDICTION_TIMEOUT_MS = 2_500
export const INTENT_ROUTING_PROMPT_HEAD_CHARS = 200

export type IntentRoutingPromptPart = {
  readonly type?: string
  readonly text?: string
  readonly synthetic?: boolean
}

export type IntentRoutingPredictionState =
  | "pending"
  | "filled"
  | "failed"
  | "timeout"
  | "not_dispatched"

export type IntentRoutingLifecycleState =
  | "created"
  | "prediction_filled"
  | "prediction_failed"
  | "prediction_timeout"
  | "not_dispatched"
  | "sealed"
  | "evicted"

export type IntentRoutingTerminalState = "live" | "sealed" | "evicted"

export type IntentRoutingTurnSnapshot = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly reuseKey: string
  readonly promptHash: string
  readonly normalizedPrompt: string
  readonly predictionReused: boolean
  readonly predictionState: IntentRoutingPredictionState
  readonly lifecycleState: IntentRoutingLifecycleState
  readonly terminalState: IntentRoutingTerminalState
  readonly resolvedModel: string | null
  readonly answers: IntentRoutingAnswers
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly sealedBy: IntentRoutingObservationRecord["sealedBy"] | null
  readonly correlationStatus: IntentRoutingObservationRecord["correlationStatus"] | null
  readonly deferredFinalization: boolean
}

export type IntentRoutingTurnHandle = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly promptHash: string
  readonly settled: Promise<void>
}

export type IntentRoutingStartTurnInput = {
  readonly sessionID: string | null | undefined
  readonly parts: readonly IntentRoutingPromptPart[]
  readonly questionVersion: number
  readonly vocabularyDigest: string
  readonly confidenceThreshold: number
  readonly configuredModelSpec: string
  readonly knownResolvedModel?: string
  readonly dispatch: (() => Promise<IntentRoutingDecisionResult>) | undefined
  readonly notDispatchedReason?: string
}

export type IntentRoutingSealInput = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly sealedBy: IntentRoutingObservationRecord["sealedBy"]
  readonly deferFinalization?: boolean
}

export type IntentRoutingTurnStoreOptions = {
  readonly maxTrackedSessions?: number
  readonly maxTurnsPerSession?: number
  readonly predictionTimeoutMs?: number
  readonly processId?: string
  readonly now?: () => number
  readonly onEntry?: (entry: IntentRoutingEntry) => void
}

export type IntentRoutingTurnStoreInspection = {
  readonly sessionCount: number
  readonly pendingCoalescingCount: number
  readonly completedCacheCount: number
  readonly evictedCount: number
}

export type IntentRoutingTurnStore = {
  startTurn(input: IntentRoutingStartTurnInput): IntentRoutingTurnHandle | null
  appendObservation(sessionID: string, turnOrdinal: number, observation: IntentRoutingObservedDelegation): boolean
  sealTurn(input: IntentRoutingSealInput): boolean
  finalizeTurn(sessionID: string, turnOrdinal: number): boolean
  deleteSession(sessionID: string): void
  dispose(): void
  getTurn(sessionID: string, turnOrdinal: number): IntentRoutingTurnSnapshot | undefined
  getSessionTurns(sessionID: string): readonly IntentRoutingTurnSnapshot[]
  getCounters(): IntentRoutingCounters
  inspect(): IntentRoutingTurnStoreInspection
}

export type MutableCounters = { -readonly [Key in keyof IntentRoutingCounters]: IntentRoutingCounters[Key] }

export type PendingGroup = {
  readonly tierOneKey: string
  readonly records: Set<MutableTurn>
  readonly startedAt: number
  active: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

export type MutableTurn = {
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly promptHash: string
  readonly normalizedPrompt: string
  readonly questionVersion: number
  readonly confidenceThreshold: number
  readonly promptHeadChars: string
  readonly promptChars: number
  readonly isContinuationCandidate: boolean
  readonly observed: IntentRoutingObservedDelegation[]
  readonly settled: Promise<void>
  settle: (() => void) | undefined
  pendingGroup: PendingGroup | undefined
  reuseKey: string
  predictionReused: boolean
  predictionState: IntentRoutingPredictionState
  lifecycleState: IntentRoutingLifecycleState
  terminalState: IntentRoutingTerminalState
  notDispatchedReason: string | null
  unavailableReason: IntentRoutingObservationRecord["unavailableReason"]
  resolvedModel: string | null
  latencyMs: number
  answers: IntentRoutingAnswers
  invalidAnswerCount: number
  truncatedInput: boolean
  sealedBy: IntentRoutingObservationRecord["sealedBy"] | null
  correlationStatus: IntentRoutingObservationRecord["correlationStatus"] | null
  deferredFinalization: boolean
  finalized: boolean
  lastAccess: number
}

export type SessionState = {
  readonly sessionID: string
  readonly turns: Map<number, MutableTurn>
  nextOrdinal: number
  lastAccess: number
}

export type TurnStoreState = {
  readonly maxTrackedSessions: number
  readonly maxTurnsPerSession: number
  readonly predictionTimeoutMs: number
  readonly processId: string
  readonly now: () => number
  readonly onEntry: (entry: IntentRoutingEntry) => void
  readonly sessions: Map<string, SessionState>
  readonly pendingByTierOne: Map<string, PendingGroup>
  readonly completedByTierTwo: Map<string, Set<MutableTurn>>
  readonly counters: MutableCounters
  readonly clocks: {
    ordinalHighWater: number
    access: number
    counterSequence: number
  }
}
