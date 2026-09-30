import {
  COMPLETION_CONTINUATION_CENSORED_CLOSURES,
  COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES,
  COMPLETION_CONTINUATION_OBSERVED_CLOSURES,
  COMPLETION_CONTINUATION_PREDICTION_STATUSES,
  COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS,
} from "../packages/jev-core/src"
import type {
  AgreementBlock,
  AgreementRate,
  CompletionContinuationReportAnalysis,
} from "./jev-w2-report-types"

const DENOMINATOR_ORDER: readonly string[] = [
  "starts",
  "records",
  ...COMPLETION_CONTINUATION_PREDICTION_STATUSES.map((status) => `prediction_status_${status}`),
  "invalid_answers",
  "uncertain_answers",
  ...COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES.map((outcome) => `gauntlet_outcome_${outcome}`),
  "outcome_status_pending",
  "outcome_status_observed",
  "outcome_status_censored",
  "outcome_closure_pending",
  ...COMPLETION_CONTINUATION_OBSERVED_CLOSURES.map((closure) => `outcome_closure_${closure}`),
  ...COMPLETION_CONTINUATION_CENSORED_CLOSURES.map((closure) => `outcome_closure_${closure}`),
  ...COMPLETION_CONTINUATION_CENSORED_CLOSURES.map((reason) => `censor_reason_${reason}`),
  ...COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS.map((reason) => `pre_input_skip_${reason}`),
  "dispatches_dropped",
  "records_evicted",
  "censored_windows",
  "malformed_lines",
  "malformed_write_rejections",
  "records_lost_to_cap",
  "sink_truncations",
  "truncation_flag_todo_items",
  "truncation_flag_todo_content",
  "truncation_flag_transcript_messages",
  "truncation_flag_transcript_content",
  "truncation_flag_diff_paths",
  "truncation_flag_diff_content",
  "truncation_flag_boulder_content",
  "truncation_flag_state",
  "transcript_available",
  "transcript_unavailable",
  "diff_available",
  "diff_unavailable",
  "boulder_available",
  "boulder_unavailable",
  "continuation_fixture_cohort_candidate",
  "continuation_fixture_cohort_non_candidate",
  "in_flight",
]

const HEURISTIC_LABELS = {
  todoComplete: "todo_complete",
  promiseComplete: "promise_complete",
  todoProgress: "todo_progress",
  stagnationStop: "stagnation_stop",
} as const

const OUTCOME_LABELS = {
  actuallyComplete: "actually_complete",
  progressing: "progressing",
  stuck: "stuck",
} as const

function percent(rate: AgreementRate): string {
  return `${((rate.numerator / rate.denominator) * 100).toFixed(2)}%`
}

function rateLine(label: string, rate: AgreementRate): string {
  const coverage = `coverage=${rate.coverageNumerator}/${rate.coverageDenominator}`
  if (rate.denominator === 0) {
    return `${label}: insufficient data (eligible denominator=0); ${coverage}`
  }
  return `${label}: ${rate.numerator}/${rate.denominator} (${percent(rate)}); ${coverage}`
}

function renderBlock(label: string, block: AgreementBlock): readonly string[] {
  const lines = [rateLine(`${label} overall`, block.overall)]
  let activeDimension = ""
  for (const row of block.crossTabs) {
    if (row.dimension !== activeDimension) {
      activeDimension = row.dimension
      lines.push(`${label} cross-tab by ${activeDimension}`)
    }
    lines.push(rateLine(`${activeDimension}=${row.bucket}`, row.rate))
  }
  return lines
}

export function renderCompletionContinuationReport(
  analysis: CompletionContinuationReportAnalysis,
): string {
  const lines = ["JEV W2 COMPLETION-CONTINUATION AGREEMENT REPORT", "", "DENOMINATORS"]
  for (const name of DENOMINATOR_ORDER) {
    lines.push(`${name}: ${analysis.denominators[name] ?? 0}`)
  }
  const identity = analysis.identity
  lines.push(
    `in_flight_identity: starts=${identity.starts} records=${identity.records} in_flight=${identity.inFlight} balanced=${identity.balanced ? "yes" : "no"}`,
    "",
    "HEURISTIC PROXY AGREEMENT",
    "eligible denominator: confident prediction + known heuristic proxy",
  )
  for (const key of ["todoComplete", "promiseComplete", "todoProgress", "stagnationStop"] as const) {
    lines.push(...renderBlock(HEURISTIC_LABELS[key], analysis.heuristicAgreement[key]), "")
  }
  lines.push(
    "OUTCOME AGREEMENT (observed non-censored labels only)",
    "eligible denominator: confident prediction + observed non-censored outcome label",
  )
  for (const key of ["actuallyComplete", "progressing", "stuck"] as const) {
    lines.push(...renderBlock(OUTCOME_LABELS[key], analysis.outcomeAgreement[key]), "")
  }
  return `${lines.join("\n")}\n`
}
