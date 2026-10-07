import type {
  CompletionContinuationCensoredClosure,
  CompletionContinuationCounters,
  CompletionContinuationDecisionResult,
  CompletionContinuationEntry,
  CompletionContinuationHeuristicFacts,
  CompletionContinuationInputTruncations,
  CompletionContinuationNotDispatchedReason,
  CompletionContinuationObservedClosure,
  CompletionContinuationOutcomeClosedBy,
  CompletionContinuationOutcomeFacts,
  CompletionContinuationOutcomeStatus,
  CompletionContinuationPredictionStatus,
  CompletionContinuationProbabilities,
  CompletionContinuationThresholdLabels,
  CompletionContinuationTodoInputItem,
  DecisionUnavailableReason,
} from "@oh-my-opencode/jev-core"
import type { CompletionContinuationInputSnapshot } from "./completion-continuation-input"

export const DEFAULT_COMPLETION_CONTINUATION_OUTCOME_WINDOW_MS = 120_000
export const DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_SESSIONS = 256
export const DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION = 64

export class CompletionContinuationOutcomeStoreDisposedError extends Error {
  constructor() {
    super("Completion-continuation outcome store is disposed")
    this.name = "CompletionContinuationOutcomeStoreDisposedError"
  }
}

export type CompletionContinuationOutcomeSnapshot = {
  readonly input?: {
    readonly todos?: readonly CompletionContinuationTodoInputItem[]
    readonly boulder?: {
      readonly total: number
      readonly completed: number
      readonly remaining: number
    } | null
  }
  readonly inputDigests?: {
    readonly todoStatus?: string
    readonly boulder?: string | null
  }
}

export type CompletionContinuationOutcomeTimer = {
  cancel(): void
  unref(): void
}

export type CompletionContinuationOutcomeClock = {
  now(): number
  schedule(delayMs: number, callback: () => void): CompletionContinuationOutcomeTimer
}

export type CompletionContinuationOutcomeHandle = {
  readonly sessionID: string
  readonly ordinal: number
}

export type CompletionContinuationOutcomeStartInput = {
  readonly sessionID: string
  readonly snapshot: CompletionContinuationInputSnapshot
  readonly inputTruncations: CompletionContinuationInputTruncations
  readonly heuristicFacts: CompletionContinuationHeuristicFacts
  readonly isContinuationCandidate: boolean
  readonly confidenceThreshold: number
}

export type CompletionContinuationActivity = {
  readonly successful: boolean
}

export type CompletionContinuationOutcomeRecordSnapshot = {
  readonly sessionID: string
  readonly ordinal: number
  readonly heuristicTerminal: boolean
  readonly heuristicFacts: CompletionContinuationHeuristicFacts
  readonly predictionStatus: CompletionContinuationPredictionStatus | "pending"
  readonly outcomeStatus: CompletionContinuationOutcomeStatus
  readonly outcomeClosedBy: CompletionContinuationOutcomeClosedBy
  readonly outcomeFacts: CompletionContinuationOutcomeFacts
  readonly continuationActivity: boolean
  readonly successfulContinuation: boolean
  readonly appended: boolean
}

export type CompletionContinuationOutcomeStoreInspection = {
  readonly sessionCount: number
  readonly recordCount: number
  readonly recordsEvicted: number
}

export type CompletionContinuationOutcomeStoreOptions = {
  readonly clock?: CompletionContinuationOutcomeClock
  readonly processId?: string
  readonly outcomeWindowMs?: number
  readonly maxSessions?: number
  readonly maxRecordsPerSession?: number
  readonly onEntry?: (entry: CompletionContinuationEntry) => boolean | void | Promise<boolean | void>
}

export type CompletionContinuationOutcomeStore = {
  start(input: CompletionContinuationOutcomeStartInput): CompletionContinuationOutcomeHandle
  finalizeHeuristic(
    handle: CompletionContinuationOutcomeHandle,
    facts?: CompletionContinuationHeuristicFacts,
  ): boolean
  resolvePrediction(
    handle: CompletionContinuationOutcomeHandle,
    result: CompletionContinuationDecisionResult,
  ): boolean
  markPredictionNotDispatched(
    handle: CompletionContinuationOutcomeHandle,
    reason: CompletionContinuationNotDispatchedReason,
  ): boolean
  markContinuationActivity(
    handle: CompletionContinuationOutcomeHandle,
    activity: CompletionContinuationActivity,
  ): boolean
  observeNextIdle(sessionID: string, snapshot: CompletionContinuationOutcomeSnapshot): number
  humanIntervention(sessionID: string): number
  deleteSession(sessionID: string): Promise<void>
  getRecord(
    handle: CompletionContinuationOutcomeHandle,
  ): CompletionContinuationOutcomeRecordSnapshot | undefined
  getSessionRecords(sessionID: string): readonly CompletionContinuationOutcomeRecordSnapshot[]
  getCounters(): CompletionContinuationCounters
  inspect(): CompletionContinuationOutcomeStoreInspection
  dispose(): Promise<void>
}

export type CompletionContinuationOutcomeClassification =
  | { readonly status: "pending"; readonly facts: CompletionContinuationOutcomeFacts }
  | {
    readonly status: "observed"
    readonly closedBy: CompletionContinuationObservedClosure
    readonly facts: CompletionContinuationOutcomeFacts
  }

export type ClassifyCompletionContinuationOutcomeInput = {
  readonly current: CompletionContinuationOutcomeSnapshot
  readonly next?: CompletionContinuationOutcomeSnapshot
  readonly continuationActivity: boolean
  readonly successfulContinuation: boolean
}

export type CompletionContinuationPredictionTerminal = {
  readonly predictionStatus: CompletionContinuationPredictionStatus
  readonly notDispatchedReason: CompletionContinuationNotDispatchedReason
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly probabilities: CompletionContinuationProbabilities
  readonly thresholdLabels: CompletionContinuationThresholdLabels
  readonly invalidAnswerCount: number
  readonly questionVersion: number
}

export type MutableCompletionContinuationOutcomeRecord = {
  readonly handle: CompletionContinuationOutcomeHandle
  readonly current: CompletionContinuationInputSnapshot
  readonly inputTruncations: CompletionContinuationInputTruncations
  readonly isContinuationCandidate: boolean
  readonly confidenceThreshold: number
  heuristicFacts: CompletionContinuationHeuristicFacts
  heuristicTerminal: boolean
  prediction: CompletionContinuationPredictionTerminal | null
  outcomeStatus: CompletionContinuationOutcomeStatus
  outcomeClosedBy: CompletionContinuationOutcomeClosedBy
  outcomeFacts: CompletionContinuationOutcomeFacts
  continuationActivity: boolean
  successfulContinuation: boolean
  appended: boolean
  lastAccess: number
  timer: CompletionContinuationOutcomeTimer | null
}

export type CompletionContinuationOutcomeSession = {
  readonly sessionID: string
  readonly records: Map<number, MutableCompletionContinuationOutcomeRecord>
  nextOrdinal: number
  lastAccess: number
  lastSignature: string | null
  lastHandle: CompletionContinuationOutcomeHandle | null
  dirtySinceIdle: boolean
}

export type CompletionContinuationOutcomeState = {
  readonly sessions: Map<string, CompletionContinuationOutcomeSession>
  readonly counters: MutableCompletionContinuationCounters
  readonly pendingWrites: Set<Promise<void>>
  readonly clock: CompletionContinuationOutcomeClock
  readonly processId: string
  readonly outcomeWindowMs: number
  readonly maxSessions: number
  readonly maxRecordsPerSession: number
  readonly onEntry: (entry: CompletionContinuationEntry) => boolean | void | Promise<boolean | void>
  access: number
  counterSequence: number
  disposing: boolean
}

export type MutableCompletionContinuationCounters = {
  -readonly [Key in keyof CompletionContinuationCounters]: CompletionContinuationCounters[Key]
}

export type CloseCompletionContinuationOutcomeInput = {
  readonly status: "observed" | "censored"
  readonly closedBy: CompletionContinuationObservedClosure | CompletionContinuationCensoredClosure
  readonly facts: CompletionContinuationOutcomeFacts
}
