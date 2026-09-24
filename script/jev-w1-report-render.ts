import { derivePredictedRoute, type IntentRoutingObservationRecord } from "@oh-my-opencode/jev-core"

import {
  FAN_OUT_BUCKETS,
  SEALED_BY_VALUES,
  calculateJevW1Metrics,
  countRecords,
  isResumeOnly,
  isUnknownOnly,
  toScoredTurn,
  type JevW1CoverageMetric,
  type JevW1Metric,
  type JevW1MetricSet,
  type JevW1ScoredTurn,
} from "./jev-w1-report-metrics"
import type { JevW1Corpus } from "./jev-w1-report-reader"

const MINIMUM_SEALED_RECORDS = 30

export class JevW1ReportIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JevW1ReportIntegrityError"
  }
}

function rate(metric: JevW1Metric, sufficient: boolean): string {
  return sufficient && metric.denominator > 0 ? (metric.numerator / metric.denominator).toFixed(6) : "insufficient data"
}

function metricLine(name: string, metric: JevW1Metric, sufficient: boolean): string {
  return `${name} numerator=${metric.numerator} denominator=${metric.denominator} rate=${rate(metric, sufficient)}`
}

function coverageLines(name: "category" | "subagent", metric: JevW1CoverageMetric, sufficient: boolean): readonly string[] {
  const withCardinality = (line: string): string => line.replace(" rate=", ` distinct_target_cardinality=${metric.targetCardinality} rate=`)
  return [
    withCardinality(metricLine(`${name}_coverage`, metric, sufficient)),
    withCardinality(metricLine(`${name}_cardinality_weighted_coverage`, {
      numerator: metric.weightedNumerator,
      denominator: metric.weightedDenominator,
    }, sufficient)),
  ]
}

function compactMetrics(metrics: JevW1MetricSet, sufficient: boolean): string {
  const compact = (metric: JevW1Metric): string => `${metric.numerator}/${metric.denominator}:${rate(metric, sufficient)}`
  return [
    `exact_route_agreement=${compact(metrics.exact)}`,
    `category_coverage=${compact(metrics.category)}`,
    `distinct_target_cardinality=${metrics.category.targetCardinality}`,
    `category_cardinality_weighted_coverage=${compact({ numerator: metrics.category.weightedNumerator, denominator: metrics.category.weightedDenominator })}`,
    `subagent_coverage=${compact(metrics.subagent)}`,
    `distinct_target_cardinality=${metrics.subagent.targetCardinality}`,
    `subagent_cardinality_weighted_coverage=${compact({ numerator: metrics.subagent.weightedNumerator, denominator: metrics.subagent.weightedDenominator })}`,
    `none_recall=${compact(metrics.noneRecall)}`,
    `none_precision=${compact(metrics.nonePrecision)}`,
    `coherence_rate=${compact(metrics.coherence)}`,
  ].join(" ")
}

function denominatorLines(corpus: JevW1Corpus, scored: readonly JevW1ScoredTurn[]): readonly string[] {
  const records = corpus.observations
  const sealed = records.length
  const inFlight = corpus.counters.recordsCreated - sealed - corpus.counters.recordsEvicted
  if (inFlight < 0 || corpus.counters.recordsCreated !== sealed + corpus.counters.recordsEvicted + inFlight) {
    throw new JevW1ReportIntegrityError(
      `records_created identity failed: ${corpus.counters.recordsCreated} != ${sealed} + ${corpus.counters.recordsEvicted} + ${inFlight}`,
    )
  }
  const incoherent = records.filter((record) => record.predictionStatus === "filled" && (
    record.answers === null || !derivePredictedRoute(record.answers).coherent
  )).length
  const entries: readonly (readonly [string, number])[] = [
    ["turns_seen", corpus.counters.turnsSeen],
    ["turns_gated_out", corpus.counters.turnsGatedOut],
    ["turns_synthetic", corpus.counters.turnsSynthetic],
    ["records_created", corpus.counters.recordsCreated],
    ["records_with_prediction", records.filter((record) => record.predictionStatus === "filled").length],
    ...SEALED_BY_VALUES.map((value) => [`records_sealed_by_${value}`, countRecords(records, (record) => record.sealedBy, value)] as const),
    ["records_evicted", corpus.counters.recordsEvicted],
    ["in_flight", inFlight],
    ["orphan_observations", corpus.counters.orphanObservations],
    ["unscorable_resume_calls", corpus.counters.unscorableResumeCalls],
    ["resume_only_records", records.filter(isResumeOnly).length],
    ["unscorable_unknown_calls", corpus.counters.unscorableUnknownCalls],
    ["unknown_only_records", records.filter(isUnknownOnly).length],
    ["unrepresentable_route_mismatches", scored.filter((turn) => turn.hasUnknown).length],
    ["dispatches_dropped", corpus.counters.dispatchesDropped],
    ["invalid_answers", records.reduce((total, record) => total + record.invalidAnswerCount, 0)],
    ["incoherent_predictions", incoherent],
    ["malformed_lines", corpus.malformedLines],
    ["malformed_write_rejections", corpus.counters.malformedWriteRejections],
    ["records_lost_to_cap", corpus.counters.recordsLostToCap],
    ["sink_truncations", corpus.counters.sinkTruncations],
    ["prediction_reused", records.filter((record) => record.predictionReused).length],
    ["truncated_input", records.filter((record) => record.truncatedInput).length],
    ...(["filled", "failed", "timeout", "not_dispatched"] as const).map((value) => [`prediction_status_${value}`, countRecords(records, (record) => record.predictionStatus, value)] as const),
    ...(["reliable", "censored", "overlap_ambiguous"] as const).map((value) => [`correlation_status_${value}`, countRecords(records, (record) => record.correlationStatus, value)] as const),
  ]
  return [
    "DENOMINATORS",
    ...entries.map(([name, value]) => `${name}=${value}`),
    `counter_process_snapshots=${corpus.counterProcessSnapshots}`,
    `records_created_identity sealed=${sealed} evicted=${corpus.counters.recordsEvicted} in_flight=${inFlight} status=ok`,
  ]
}

function scoringRecords(records: readonly IntentRoutingObservationRecord[]): {
  readonly predictionEligible: readonly IntentRoutingObservationRecord[]
  readonly scored: readonly JevW1ScoredTurn[]
} {
  const reliable = records.filter((record) => record.correlationStatus === "reliable")
  const predictionEligible = reliable.filter((record) => record.predictionStatus === "filled")
  return { predictionEligible, scored: predictionEligible.filter((record) => !isResumeOnly(record)).map(toScoredTurn) }
}

export function renderJevW1Report(corpus: JevW1Corpus): string {
  const { predictionEligible, scored } = scoringRecords(corpus.observations)
  const metrics = calculateJevW1Metrics(scored)
  const sufficient = corpus.observations.length >= MINIMUM_SEALED_RECORDS
  const countStatus = (value: IntentRoutingObservationRecord["predictionStatus"]): number => countRecords(corpus.observations, (record) => record.predictionStatus, value)
  const countCorrelation = (value: IntentRoutingObservationRecord["correlationStatus"]): number => countRecords(corpus.observations, (record) => record.correlationStatus, value)
  const mixedResume = scored.filter((turn) => turn.record.observed.some((item) => item.routeClass === "unscorable_resume") && turn.record.observed.some((item) => item.routeClass !== "unscorable_resume")).length
  const lines = [
    ...denominatorLines(corpus, scored),
    "", "ELIGIBILITY",
    `headline_eligibility correlation_status=reliable censored_excluded=${countCorrelation("censored")} overlap_ambiguous_excluded=${countCorrelation("overlap_ambiguous")}`,
    `prediction_rate_eligibility filled=${countStatus("filled")} failed_excluded=${countStatus("failed")} timeout_excluded=${countStatus("timeout")} not_dispatched_excluded=${countStatus("not_dispatched")}`,
    `scoring_audit resume_only_excluded=${predictionEligible.filter(isResumeOnly).length} unknown_scored=${scored.filter((turn) => turn.hasUnknown).length} mixed_resume_routes_retained=${mixedResume}`,
    `scored_incorrect invalid=${scored.filter((turn) => !turn.routeAnswersValid).length} incoherent=${scored.filter((turn) => !turn.coherent).length}`,
    "observed_delegations=attempts_not_successes",
    sufficient ? `minimum_data sealed_records=${corpus.observations.length} required=${MINIMUM_SEALED_RECORDS} status=sufficient` : `insufficient data: sealed_records=${corpus.observations.length} required=${MINIMUM_SEALED_RECORDS}`,
    "", "RATES", metricLine("exact_route_agreement", metrics.exact, sufficient),
    `multi_route_turns=${metrics.multiRouteTurns}`,
    ...coverageLines("category", metrics.category, sufficient),
    ...coverageLines("subagent", metrics.subagent, sufficient),
    metricLine("none_recall", metrics.noneRecall, sufficient),
    metricLine("none_precision", metrics.nonePrecision, sufficient),
    metricLine("coherence_rate", metrics.coherence, sufficient),
    "", "FAN-OUT BY SEALED-BY CROSS-TAB",
  ]
  for (const fanOut of FAN_OUT_BUCKETS) {
    for (const sealedBy of SEALED_BY_VALUES) {
      const cohort = scored.filter((turn) => turn.record.fanOutBucket === fanOut && turn.record.sealedBy === sealedBy)
      lines.push(`fan_out=${fanOut} sealed_by=${sealedBy} records=${cohort.length} ${compactMetrics(calculateJevW1Metrics(cohort), sufficient)}`)
    }
  }
  const continuation = scored.filter((turn) => turn.record.isContinuationCandidate)
  lines.push(
    "", "CONTINUATION COHORT",
    `continuation_candidate records=${continuation.length} ${compactMetrics(calculateJevW1Metrics(continuation), sufficient)}`,
    "", "FIXTURE-SCORED ONLY: no live harness ground truth",
    "intent_coverage live_ground_truth=unavailable", "ambiguous_coverage live_ground_truth=unavailable",
    "", "LIMITATIONS", "live_disagreements_reproducible=false fixture_growth=manual prompt_head_chars_retained=200",
    "PROMPT SHA-256 RECURRENCE",
  )
  const recurrences = new Map<string, number>()
  for (const record of corpus.observations) recurrences.set(record.promptFullSha256, (recurrences.get(record.promptFullSha256) ?? 0) + 1)
  for (const [sha256, count] of [...recurrences].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`prompt_full_sha256=${sha256} count=${count}`)
  }
  return `${lines.join("\n")}\n`
}
