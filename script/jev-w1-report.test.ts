// allow: SIZE_OK - report acceptance tests keep the generated corpus contract and every named metric in one review surface.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeSyntheticCorpus } from "./jev-w1-report.fixtures"
import { buildJevW1Report } from "./jev-w1-report"

const requiredDenominators = [
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

function outputValue(output: string, name: string): number {
  const line = output.split("\n").find((candidate) => candidate.startsWith(`${name}=`))
  if (line === undefined) throw new Error(`Missing report value: ${name}`)
  return Number.parseInt(line.slice(name.length + 1), 10)
}

describe("Jev W1 intent-routing report", () => {
  let root = ""
  let output = ""

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jev-w1-report-"))
    writeSyntheticCorpus(root)
    output = buildJevW1Report(root)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("#given a known corpus #when rendered #then every denominator precedes every rate and has its known count", () => {
    const denominatorIndex = output.indexOf("DENOMINATORS\n")
    const rateIndex = output.indexOf("RATES\n")

    expect(denominatorIndex).toBe(0)
    expect(rateIndex).toBeGreaterThan(denominatorIndex)
    for (const name of requiredDenominators) {
      expect(output.indexOf(`${name}=`)).toBeGreaterThan(denominatorIndex)
      expect(output.indexOf(`${name}=`)).toBeLessThan(rateIndex)
    }
    expect(requiredDenominators.map((name) => [name, outputValue(output, name)])).toEqual([
      ["turns_seen", 40], ["turns_gated_out", 4], ["turns_synthetic", 3], ["records_created", 35],
      ["records_with_prediction", 29], ["records_sealed_by_next_turn", 6], ["records_sealed_by_session_idle", 8],
      ["records_sealed_by_seal_timeout", 7], ["records_sealed_by_dispose", 7], ["records_sealed_by_session_deleted", 4],
      ["records_evicted", 1], ["in_flight", 2], ["orphan_observations", 2], ["unscorable_resume_calls", 2],
      ["resume_only_records", 1], ["unscorable_unknown_calls", 1], ["unknown_only_records", 1],
      ["unrepresentable_route_mismatches", 1], ["dispatches_dropped", 2], ["invalid_answers", 1],
      ["incoherent_predictions", 1], ["malformed_lines", 2], ["malformed_write_rejections", 1],
      ["records_lost_to_cap", 5], ["sink_truncations", 1], ["prediction_reused", 2], ["truncated_input", 1],
      ["prediction_status_filled", 29], ["prediction_status_failed", 1], ["prediction_status_timeout", 1],
      ["prediction_status_not_dispatched", 1], ["correlation_status_reliable", 27],
      ["correlation_status_censored", 2], ["correlation_status_overlap_ambiguous", 3],
    ])
  })

  test("#given counter snapshots across truncation epochs #when resolved #then the highest sequence in the highest epoch supersedes older values", () => {
    expect(output).toContain("counter_process_snapshots=2")
    expect(output).toContain("records_created_identity sealed=32 evicted=1 in_flight=2 status=ok")
    expect(outputValue(output, "turns_seen")).toBe(40)
    expect(outputValue(output, "records_created")).toBe(35)
  })

  test("#given censored and overlap-marked records #when headline eligibility is applied #then both are counted but excluded", () => {
    expect(output).toContain("headline_eligibility correlation_status=reliable censored_excluded=2 overlap_ambiguous_excluded=3")
    expect(output).toContain("exact_route_agreement numerator=12 denominator=19 rate=0.631579")
    expect(outputValue(output, "correlation_status_overlap_ambiguous")).toBe(3)
  })

  test("#given resume-only unknown-only and mixed resume records #when scored #then resume and unknown remain distinct", () => {
    expect(output).toContain("scoring_audit resume_only_excluded=1 unknown_scored=1 mixed_resume_routes_retained=1")
    expect(outputValue(output, "resume_only_records")).toBe(1)
    expect(outputValue(output, "unknown_only_records")).toBe(1)
    expect(outputValue(output, "unrepresentable_route_mismatches")).toBe(1)
    expect(output).toContain("exact_route_agreement numerator=12 denominator=19")
  })

  test("#given unavailable invalid and incoherent predictions #when rates are computed #then only unavailable statuses are absent", () => {
    expect(output).toContain("prediction_rate_eligibility filled=29 failed_excluded=1 timeout_excluded=1 not_dispatched_excluded=1")
    expect(output).toContain("scored_incorrect invalid=1 incoherent=1")
    expect(output).toContain("coherence_rate numerator=22 denominator=23 rate=0.956522")
  })

  test("#given distinct none conditioning sets and mixed fan-out #when metrics render #then recall precision and coverage are named correctly", () => {
    expect(output).toContain("none_recall numerator=4 denominator=5 rate=0.800000")
    expect(output).toContain("none_precision numerator=4 denominator=7 rate=0.571429")
    expect(output).toContain("category_coverage numerator=17 denominator=23 distinct_target_cardinality=15 rate=0.739130")
    expect(output).toContain("category_cardinality_weighted_coverage numerator=20 denominator=26 distinct_target_cardinality=15 rate=0.769231")
    expect(output).toContain("subagent_coverage numerator=19 denominator=23 distinct_target_cardinality=7 rate=0.826087")
    expect(output).toContain("FIXTURE-SCORED ONLY")
    expect(output).toContain("intent_coverage live_ground_truth=unavailable")
    expect(output).toContain("ambiguous_coverage live_ground_truth=unavailable")
  })

  test("#given all fan-out and sealing cohorts #when cross-tabbed #then every bucket and sealedBy value has a row and continuation is separate", () => {
    for (const fanOut of ["zero", "one", "many"] as const) expect(output).toContain(`fan_out=${fanOut}`)
    for (const sealedBy of ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const) {
      expect(output).toContain(`sealed_by=${sealedBy}`)
    }
    expect(output).toContain("CONTINUATION COHORT")
    expect(output).toContain("continuation_candidate records=2")
    expect(output).toContain("fan_out=many sealed_by=dispose records=3 exact_route_agreement=0/0:insufficient data category_coverage=3/3:1.000000 distinct_target_cardinality=3 category_cardinality_weighted_coverage=4/4:1.000000 subagent_coverage=2/3:0.666667 distinct_target_cardinality=3 subagent_cardinality_weighted_coverage=3/4:0.750000")
    expect(output).toContain("continuation_candidate records=2 exact_route_agreement=2/2:1.000000 category_coverage=2/2:1.000000 distinct_target_cardinality=0 category_cardinality_weighted_coverage=2/2:1.000000")
    expect(output).toContain("multi_route_turns=4")
    expect(output).toContain("observed_delegations=attempts_not_successes")
  })

  test("#given an empty sink #when rendered #then denominators are zero and every rate is insufficient data", () => {
    const emptyRoot = join(root, "empty")
    mkdirSync(emptyRoot)

    const emptyOutput = buildJevW1Report(emptyRoot)

    for (const name of requiredDenominators) expect(outputValue(emptyOutput, name)).toBe(0)
    expect(emptyOutput).toContain("insufficient data: sealed_records=0 required=30")
    expect(emptyOutput).toContain("exact_route_agreement numerator=0 denominator=0 rate=insufficient data")
    expect(emptyOutput).not.toContain("NaN")
  })
})
