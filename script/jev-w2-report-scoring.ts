import type { CompletionContinuationObservation } from "../packages/jev-core/src"
import {
  CLOSURE_REASON_BUCKETS,
  CONTINUATION_FIXTURE_COHORTS,
  PRESENCE_BUCKETS,
  type AgreementBlock,
  type AgreementDimension,
  type AgreementRate,
  type AgreementSpec,
  type CompletionContinuationQuestionKey,
  type HeuristicAgreementKey,
  type OutcomeAgreementCohort,
} from "./jev-w2-report-types"

function predictedValue(
  record: CompletionContinuationObservation,
  question: CompletionContinuationQuestionKey,
): boolean | null {
  switch (record.thresholdLabels[question]) {
    case "would_true": return true
    case "would_false": return false
    case "uncertain": return null
    case "unavailable": return null
  }
}

function scoreRate(
  records: readonly CompletionContinuationObservation[],
  spec: AgreementSpec,
): AgreementRate {
  let numerator = 0
  let denominator = 0
  for (const record of records) {
    const predicted = predictedValue(record, spec.question)
    const target = spec.target(record)
    if (predicted === null || target === null) continue
    denominator += 1
    if (predicted === target) numerator += 1
  }
  return {
    numerator,
    denominator,
    coverageNumerator: denominator,
    coverageDenominator: records.length,
  }
}

function closureBucket(record: CompletionContinuationObservation): string {
  return record.outcomeClosedBy ?? "pending"
}

function presence(value: string | null): string {
  return value === null ? "absent" : "present"
}

function cohortBucket(record: CompletionContinuationObservation): string {
  return record.isContinuationCandidate ? "candidate" : "non_candidate"
}

export function completionContinuationOutcomeCohort(
  record: CompletionContinuationObservation,
): OutcomeAgreementCohort {
  const closedBy = record.outcomeClosedBy
  switch (closedBy) {
    case "tracked_work_complete":
    case "tracked_work_progressed":
    case "unchanged_next_idle":
      return "autonomous"
    case "human_intervention":
      return "human_interactive"
    case "timeout":
    case "dispose":
    case "session_deleted":
    case "evicted":
      return closedBy
    case null:
      return "pending"
    default: {
      const exhaustive: never = closedBy
      throw new TypeError(`Unsupported outcome closure: ${String(exhaustive)}`)
    }
  }
}

const CROSS_TAB_DIMENSIONS = [
  {
    dimension: "closure_reason",
    buckets: CLOSURE_REASON_BUCKETS,
    select: closureBucket,
  },
  {
    dimension: "transcript_present",
    buckets: PRESENCE_BUCKETS,
    select: (record: CompletionContinuationObservation) => presence(record.inputDigests.transcript),
  },
  {
    dimension: "boulder_present",
    buckets: PRESENCE_BUCKETS,
    select: (record: CompletionContinuationObservation) => presence(record.inputDigests.boulder),
  },
  {
    dimension: "diff_present",
    buckets: PRESENCE_BUCKETS,
    select: (record: CompletionContinuationObservation) => presence(record.inputDigests.diff),
  },
  {
    dimension: "continuation_fixture_cohort",
    buckets: CONTINUATION_FIXTURE_COHORTS,
    select: cohortBucket,
  },
] as const satisfies readonly {
  readonly dimension: AgreementDimension
  readonly buckets: readonly string[]
  readonly select: (record: CompletionContinuationObservation) => string
}[]

export function scoreCompletionContinuationAgreement(
  records: readonly CompletionContinuationObservation[],
  spec: AgreementSpec,
): AgreementBlock {
  const crossTabs = CROSS_TAB_DIMENSIONS.flatMap((dimension) =>
    dimension.buckets.map((bucket) => ({
      dimension: dimension.dimension,
      bucket,
      rate: scoreRate(records.filter((record) => dimension.select(record) === bucket), spec),
    })))
  return { overall: scoreRate(records, spec), crossTabs }
}

function observedTarget(
  record: CompletionContinuationObservation,
  question: CompletionContinuationQuestionKey,
): boolean | null {
  if (record.outcomeStatus !== "observed") return null
  const value = record.outcomeFacts[question]
  return typeof value === "boolean" ? value : null
}

export const HEURISTIC_AGREEMENT_SPECS: Readonly<Record<HeuristicAgreementKey, AgreementSpec>> = {
  todoComplete: {
    question: "actuallyComplete",
    target: (record) => record.heuristicFacts.todoComplete,
  },
  promiseComplete: {
    question: "actuallyComplete",
    target: (record) => record.heuristicFacts.promiseComplete,
  },
  todoProgress: {
    question: "progressing",
    target: (record) => record.heuristicFacts.todoProgress,
  },
  stagnationStop: {
    question: "stuck",
    target: (record) => record.heuristicFacts.stagnationStop,
  },
}

export const OUTCOME_AGREEMENT_SPECS: Readonly<
  Record<CompletionContinuationQuestionKey, AgreementSpec>
> = {
  actuallyComplete: {
    question: "actuallyComplete",
    target: (record) => observedTarget(record, "actuallyComplete"),
  },
  progressing: {
    question: "progressing",
    target: (record) => observedTarget(record, "progressing"),
  },
  stuck: {
    question: "stuck",
    target: (record) => observedTarget(record, "stuck"),
  },
}
