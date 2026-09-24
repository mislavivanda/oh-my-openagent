// allow: SIZE_OK - one synthetic-corpus acceptance suite pins the report's conditioning rules together.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeSyntheticCorpus } from "./jev-w1-report.fixtures"
import { generateJevW1Report } from "./jev-w1-report"

let corpusRoot = ""
let report = ""

function denominator(name: string): number {
  const match = new RegExp(`^${name}: (\\d+)$`, "m").exec(report)
  expect(match).not.toBeNull()
  return Number(match?.[1] ?? Number.NaN)
}

beforeAll(() => {
  corpusRoot = mkdtempSync(join(tmpdir(), "jev-w1-report-"))
  writeSyntheticCorpus(corpusRoot)
  report = generateJevW1Report(corpusRoot)
})

afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true })
})

describe("Jev W1 intent-routing report", () => {
  test("#given superseding counter epochs #when denominators are rendered #then every required denominator uses the latest epoch and sequence", () => {
    const expected = {
      turns_seen: 25,
      turns_gated_out: 3,
      turns_synthetic: 3,
      records_created: 22,
      records_with_prediction: 14,
      records_sealed_by_next_turn: 7,
      records_sealed_by_session_idle: 3,
      records_sealed_by_seal_timeout: 2,
      records_sealed_by_dispose: 2,
      records_sealed_by_session_deleted: 3,
      records_evicted: 2,
      orphan_observations: 3,
      unscorable_resume_calls: 3,
      resume_only_records: 1,
      unscorable_unknown_calls: 3,
      unknown_only_records: 1,
      unrepresentable_route_mismatches: 3,
      dispatches_dropped: 4,
      invalid_answers: 1,
      incoherent_predictions: 1,
      malformed_lines: 2,
      malformed_write_rejections: 3,
      records_lost_to_cap: 3,
      sink_truncations: 3,
      prediction_reused: 1,
      truncated_input: 1,
      prediction_status_filled: 14,
      prediction_status_failed: 1,
      prediction_status_timeout: 1,
      prediction_status_not_dispatched: 1,
      correlation_status_reliable: 15,
      correlation_status_censored: 1,
      correlation_status_overlap_ambiguous: 1,
    } as const

    for (const [name, value] of Object.entries(expected)) expect(denominator(name)).toBe(value)
    expect(report).not.toContain("turns_seen: 1025")
  })

  test("#given sealed evicted and live records #when accounting is checked #then the creation identity holds", () => {
    expect(denominator("records_sealed")).toBe(17)
    expect(denominator("records_in_flight")).toBe(3)
    expect(report).toContain("identity: records_created(22) == sealed(17) + evicted(2) + in_flight(3)")
  })

  test("#given reliable censored and overlap records #when the headline is scored #then only reliable records enter it", () => {
    expect(report).toContain("route_agreement: 5/9 = 55.56% (eligible_denominator=9)")
    expect(report).toContain("correlation_status_censored: 1")
    expect(report).toContain("correlation_status_overlap_ambiguous: 1")
  })

  test("#given resume-only unknown-only and mixed-resume records #when routes are derived #then resume is excluded while unknown is an incorrect representability failure", () => {
    expect(denominator("resume_only_records")).toBe(1)
    expect(denominator("unknown_only_records")).toBe(1)
    expect(denominator("unrepresentable_route_mismatches")).toBe(3)
    expect(report).toContain("route_agreement: 5/9 = 55.56% (eligible_denominator=9)")
    expect(report).not.toContain("route_agreement: 5/8 = 62.50%")
    expect(report).toContain("fan_out_many: 2/2 = 100.00% (eligible_denominator=2)")
  })

  test("#given every prediction status plus invalid and incoherent filled answers #when eligibility is applied #then missing predictions are excluded and answered failures score incorrect", () => {
    expect(denominator("prediction_status_failed")).toBe(1)
    expect(denominator("prediction_status_timeout")).toBe(1)
    expect(denominator("prediction_status_not_dispatched")).toBe(1)
    expect(report).toContain("fan_out_one: 2/6 = 33.33% (eligible_denominator=6)")
    expect(report).toContain("coherence_rate: 8/9 = 88.89% (eligible_denominator=9)")
    expect(denominator("invalid_answers")).toBe(1)
    expect(denominator("incoherent_predictions")).toBe(1)
  })

  test("#given scalar predictions and two multi-route turns #when exact agreement is scored #then cardinality-many turns are coverage-only", () => {
    expect(report).toContain("multi_route_turns_coverage_only: 2")
    expect(report).toContain("route_agreement: 5/9 = 55.56% (eligible_denominator=9)")
  })

  test("#given actual-none and predicted-none conditioning sets #when both rates are rendered #then recall and precision differ", () => {
    expect(report).toContain("none_recall: 1/1 = 100.00% (eligible_denominator=1)")
    expect(report).toContain("none_precision: 1/3 = 33.33% (eligible_denominator=3)")
  })

  test("#given single-target and multi-target turns #when per-question coverage is rendered #then cardinality-weighted coverage differs", () => {
    expect(report).toContain("category_coverage: 4/7 = 57.14% (eligible_denominator=7, distinct_target_cardinality=9)")
    expect(report).toContain("category_coverage_cardinality_weighted: 4/9 = 44.44% (eligible_denominator=9, distinct_target_cardinality=9)")
    expect(report).toContain("subagent_coverage: 2/2 = 100.00% (eligible_denominator=2, distinct_target_cardinality=4)")
    expect(report).toContain("subagent_coverage_cardinality_weighted: 2/4 = 50.00% (eligible_denominator=4, distinct_target_cardinality=4)")
  })

  test("#given every fan-out seal and continuation cohort #when breakdowns render #then every conditioning row is explicit", () => {
    for (const bucket of ["zero", "one", "many"]) expect(report).toMatch(new RegExp(`^fan_out_${bucket}:`, "m"))
    for (const sealedBy of ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"]) {
      expect(report).toMatch(new RegExp(`^sealed_by_${sealedBy}:`, "m"))
    }
    expect(report).toContain("continuation_candidate_true: 1/1 = 100.00% (eligible_denominator=1)")
    expect(report).toContain("continuation_candidate_false: 4/8 = 50.00% (eligible_denominator=8)")
  })

  test("#given a live sink without intent ground truth or full prompts #when disclosures render #then fixture-only scoring and SHA recurrence are explicit", () => {
    expect(report.indexOf("DENOMINATORS")).toBeLessThan(report.indexOf("ROUTE AGREEMENT"))
    expect(report).toContain("INTENT AND AMBIGUOUS: FIXTURE-SCORED ONLY, NO LIVE GROUND TRUTH")
    expect(report).toContain("observed delegations are attempts captured before execution, not successes")
    expect(report).toContain("only a 200-char head is retained")
    expect(report).toMatch(/^[a-f0-9]{64} count=1$/m)
  })
})
