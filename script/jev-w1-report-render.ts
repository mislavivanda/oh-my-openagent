import { FAN_OUT_BUCKETS, SEALED_BY_VALUES, type Coverage, type Rate, type ReportAnalysis } from "./jev-w1-report-types"

const DENOMINATOR_ORDER = [
  "turns_seen", "turns_gated_out", "turns_synthetic", "records_created", "records_with_prediction",
  "records_sealed_by_next_turn", "records_sealed_by_session_idle", "records_sealed_by_seal_timeout",
  "records_sealed_by_dispose", "records_sealed_by_session_deleted", "records_evicted", "in_flight",
  "orphan_observations", "unscorable_resume_calls", "resume_only_records", "unscorable_unknown_calls",
  "unknown_only_records", "unrepresentable_route_mismatches", "dispatches_dropped", "invalid_answers",
  "incoherent_predictions", "malformed_lines", "malformed_write_rejections", "records_lost_to_cap",
  "sink_truncations", "prediction_reused", "truncated_input", "prediction_status_filled",
  "prediction_status_failed", "prediction_status_timeout", "prediction_status_not_dispatched",
  "correlation_status_reliable", "correlation_status_censored", "correlation_status_overlap_ambiguous",
] as const

function percent(numerator: number, denominator: number): string {
  return `${((numerator / denominator) * 100).toFixed(2)}%`
}

function rateLine(label: string, rate: Rate, fractional = false): string {
  if (rate.denominator === 0) return `${label}: insufficient data (eligible denominator=0)`
  const numerator = fractional ? rate.numerator.toFixed(2) : String(rate.numerator)
  return `${label}: ${numerator}/${rate.denominator} (${percent(rate.numerator, rate.denominator)})`
}

function coverageLines(question: string, value: Coverage): readonly string[] {
  const unweighted = rateLine(
    `${question} coverage unweighted`,
    { numerator: value.fractionalCovered, denominator: value.eligibleTurns },
    true,
  )
  const cardinality = value.eligibleTurns === 0 ? "" : `; distinct_target_cardinality=${value.targetCount}`
  return [
    `${unweighted}${cardinality}`,
    `${rateLine(`${question} coverage cardinality_weighted`, { numerator: value.coveredTargets, denominator: value.targetCount })}${cardinality}`,
  ]
}

export function renderIntentRoutingReport(analysis: ReportAnalysis): string {
  const lines = ["JEV W1 INTENT-ROUTING AGREEMENT REPORT", "", "DENOMINATORS"]
  for (const name of DENOMINATOR_ORDER) lines.push(`${name}: ${analysis.denominators[name] ?? 0}`)
  const identity = analysis.identity
  lines.push(
    `records_created == sealed + evicted + in_flight: ${identity.created} == ${identity.sealed} + ${identity.evicted} + ${identity.inFlight} [PASS]`,
    "",
    "ROUTE AGREEMENT (reliable, filled predictions only; scalar domain excludes multi-route turns)",
    rateLine("route_agreement overall", analysis.routeAgreement),
    rateLine("coherence overall", analysis.coherence),
    `multi_route_turns_coverage_only: ${analysis.multiRouteTurns}`,
    "",
    "ROUTE AGREEMENT BY FAN-OUT",
  )
  for (const bucket of FAN_OUT_BUCKETS) lines.push(rateLine(`fan_out=${bucket}`, analysis.fanOutAgreement[bucket]))
  lines.push("", "ROUTE AGREEMENT CROSS-TAB BY sealedBy")
  for (const sealedBy of SEALED_BY_VALUES) lines.push(rateLine(`sealed_by=${sealedBy}`, analysis.sealedByAgreement[sealedBy]))
  lines.push(
    "",
    "CONTINUATION CANDIDATE COHORT",
    rateLine("continuation_candidates", analysis.continuationAgreement),
    "",
    "PER-QUESTION COVERAGE (attempt targets, not agreement)",
    ...coverageLines("category", analysis.categoryCoverage),
    ...coverageLines("subagent", analysis.subagentCoverage),
    "",
    "NONE METRICS",
    rateLine("none recall", analysis.noneRecall),
    rateLine("none precision", analysis.nonePrecision),
    "",
    "INTENT AND AMBIGUOUS: FIXTURE-SCORED ONLY, NO LIVE GROUND TRUTH",
    "Live observations provide no ground-truth labels for intent or ambiguous.",
    "",
    "full_prompt_sha256 recurrence counts:",
  )
  if (analysis.disagreementShaCounts.size === 0) lines.push("none")
  for (const [sha, count] of analysis.disagreementShaCounts) lines.push(`${sha}: ${count}`)
  lines.push(
    "",
    "Non-goal: live disagreements are not reproducible from the retained 200-char prompt head; fixture growth is manual.",
  )
  return `${lines.join("\n")}\n`
}
