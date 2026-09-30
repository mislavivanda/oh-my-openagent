import type { DecisionUnavailableReason } from "./types"

export const COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES = [
  "no_todos",
  "all_todos_complete",
  "injection_in_flight",
  "max_failures",
  "cooldown",
  "latest_compaction",
  "agent_skipped",
  "compaction_agent_unknown",
  "compaction_guard",
  "continuation_stopped",
  "turn_boundary_block",
  "stagnation_stop",
  "continuation_scheduled",
] as const

export const COMPLETION_CONTINUATION_THRESHOLD_LABELS = [
  "would_true",
  "would_false",
  "uncertain",
  "unavailable",
] as const

export const COMPLETION_CONTINUATION_PREDICTION_STATUSES = [
  "filled",
  "failed",
  "timeout",
  "not_dispatched",
] as const

export const COMPLETION_CONTINUATION_OBSERVED_CLOSURES = [
  "tracked_work_complete",
  "tracked_work_progressed",
  "unchanged_next_idle",
] as const

export const COMPLETION_CONTINUATION_CENSORED_CLOSURES = [
  "timeout",
  "dispose",
  "session_deleted",
  "human_intervention",
  "evicted",
] as const

export const COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS = [
  "alreadyComplete",
  "recovering",
  "cancelled",
  "syncHandoff",
  "tokenLimit",
  "recentAbort",
  "backgroundTasks",
  "assistantAborted",
  "pendingQuestion",
  "internalContinuationPending",
  "messagesUnavailable",
  "todosUnavailable",
] as const

export type CompletionContinuationGauntletOutcome =
  (typeof COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES)[number]
export type CompletionContinuationThresholdLabel =
  (typeof COMPLETION_CONTINUATION_THRESHOLD_LABELS)[number]
export type CompletionContinuationPredictionStatus =
  (typeof COMPLETION_CONTINUATION_PREDICTION_STATUSES)[number]
export type CompletionContinuationObservedClosure =
  (typeof COMPLETION_CONTINUATION_OBSERVED_CLOSURES)[number]
export type CompletionContinuationCensoredClosure =
  (typeof COMPLETION_CONTINUATION_CENSORED_CLOSURES)[number]
export type CompletionContinuationOutcomeClosedBy =
  CompletionContinuationObservedClosure | CompletionContinuationCensoredClosure | null
export type CompletionContinuationOutcomeStatus = "pending" | "observed" | "censored"
export type CompletionContinuationOutcomeTruth = boolean | "unknown"
export type CompletionContinuationNotDispatchedReason = "max_inflight" | null
export type CompletionContinuationPreInputSkipReason =
  (typeof COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS)[number]

export type CompletionContinuationInputDigests = {
  readonly todoStatus: string
  readonly transcript: string | null
  readonly diff: string | null
  readonly boulder: string | null
}

export type CompletionContinuationInputTruncations = {
  readonly todoItems: boolean
  readonly todoContent: boolean
  readonly transcriptMessages: boolean
  readonly transcriptContent: boolean
  readonly diffPaths: boolean
  readonly diffContent: boolean
  readonly boulderContent: boolean
  readonly state: boolean
}

export type CompletionContinuationProbabilities = {
  readonly actuallyComplete: number | null
  readonly progressing: number | null
  readonly stuck: number | null
}

export type CompletionContinuationThresholdLabels = {
  readonly actuallyComplete: CompletionContinuationThresholdLabel
  readonly progressing: CompletionContinuationThresholdLabel
  readonly stuck: CompletionContinuationThresholdLabel
}

export type CompletionContinuationHeuristicFacts = {
  readonly gauntletOutcome: CompletionContinuationGauntletOutcome
  readonly todoComplete: boolean | null
  readonly promiseComplete: boolean | null
  readonly todoProgress: boolean | null
  readonly stagnationStop: boolean | null
}

export type CompletionContinuationOutcomeFacts = {
  readonly actuallyComplete: CompletionContinuationOutcomeTruth
  readonly progressing: CompletionContinuationOutcomeTruth
  readonly stuck: CompletionContinuationOutcomeTruth
}

export type CompletionContinuationObservation = {
  readonly kind: "observation"
  readonly schemaVersion: number
  readonly questionVersion: number
  readonly recordedAt: string
  readonly sessionID: string
  readonly ordinal: number
  readonly counterEpoch: number
  readonly inputDigests: CompletionContinuationInputDigests
  readonly inputTruncations: CompletionContinuationInputTruncations
  readonly isContinuationCandidate: boolean
  readonly probabilities: CompletionContinuationProbabilities
  readonly thresholdLabels: CompletionContinuationThresholdLabels
  readonly confidenceThreshold: number
  readonly heuristicFacts: CompletionContinuationHeuristicFacts
  readonly outcomeFacts: CompletionContinuationOutcomeFacts
  readonly outcomeStatus: CompletionContinuationOutcomeStatus
  readonly outcomeClosedBy: CompletionContinuationOutcomeClosedBy
  readonly predictionStatus: CompletionContinuationPredictionStatus
  readonly notDispatchedReason: CompletionContinuationNotDispatchedReason
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly invalidAnswerCount: number
}

export type CompletionContinuationPreInputSkips = Readonly<
  Record<CompletionContinuationPreInputSkipReason, number>
>

export type CompletionContinuationCounters = {
  readonly starts: number
  readonly preInputSkips: CompletionContinuationPreInputSkips
  readonly dispatchesDropped: number
  readonly recordsEvicted: number
  readonly censoredWindows: number
  readonly malformedLines: number
  readonly malformedWriteRejections: number
  readonly recordsLostToCap: number
  readonly sinkTruncations: number
}

export type CompletionContinuationCounterDelta = {
  readonly kind: "counter_delta"
  readonly schemaVersion: number
  readonly recordedAt: string
  readonly processId: string
  readonly counterEpoch: number
  readonly monotonicSeq: number
  readonly counters: CompletionContinuationCounters
}

export type CompletionContinuationEntry =
  | CompletionContinuationObservation
  | CompletionContinuationCounterDelta
