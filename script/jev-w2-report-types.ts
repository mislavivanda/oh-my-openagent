import type {
  CompletionContinuationCensoredClosure,
  CompletionContinuationObservation,
  CompletionContinuationObservedClosure,
} from "../packages/jev-core/src"

export const COMPLETION_CONTINUATION_QUESTION_KEYS = [
  "actuallyComplete",
  "progressing",
  "stuck",
] as const

export const HEURISTIC_AGREEMENT_KEYS = [
  "todoComplete",
  "promiseComplete",
  "todoProgress",
  "stagnationStop",
] as const

export const CLOSURE_REASON_BUCKETS = [
  "pending",
  "tracked_work_complete",
  "tracked_work_progressed",
  "unchanged_next_idle",
  "timeout",
  "dispose",
  "session_deleted",
  "human_intervention",
  "evicted",
] as const

export const PRESENCE_BUCKETS = ["present", "absent"] as const
export const CONTINUATION_FIXTURE_COHORTS = ["candidate", "non_candidate"] as const

export type CompletionContinuationQuestionKey =
  (typeof COMPLETION_CONTINUATION_QUESTION_KEYS)[number]
export type HeuristicAgreementKey = (typeof HEURISTIC_AGREEMENT_KEYS)[number]
export type ClosureReasonBucket =
  | CompletionContinuationObservedClosure
  | CompletionContinuationCensoredClosure
  | "pending"
export type AgreementDimension =
  | "closure_reason"
  | "transcript_present"
  | "boulder_present"
  | "diff_present"
  | "continuation_fixture_cohort"

export type AgreementRate = {
  readonly numerator: number
  readonly denominator: number
  readonly coverageNumerator: number
  readonly coverageDenominator: number
}

export type AgreementCrossTab = {
  readonly dimension: AgreementDimension
  readonly bucket: string
  readonly rate: AgreementRate
}

export type AgreementBlock = {
  readonly overall: AgreementRate
  readonly crossTabs: readonly AgreementCrossTab[]
}

export type CompletionContinuationReportAnalysis = {
  readonly denominators: Readonly<Record<string, number>>
  readonly identity: {
    readonly starts: number
    readonly records: number
    readonly inFlight: number
    readonly balanced: boolean
  }
  readonly heuristicAgreement: Readonly<Record<HeuristicAgreementKey, AgreementBlock>>
  readonly outcomeAgreement: Readonly<Record<CompletionContinuationQuestionKey, AgreementBlock>>
}

export type AgreementSpec = {
  readonly question: CompletionContinuationQuestionKey
  readonly target: (record: CompletionContinuationObservation) => boolean | null
}
