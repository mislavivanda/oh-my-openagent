import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeSyntheticCorpus } from "./jev-w1-report.fixtures"
import { generateIntentRoutingReport } from "./jev-w1-report"

let corpusDir = ""

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), "jev-w1-report-"))
  writeSyntheticCorpus(corpusDir)
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

describe("#given a generated intent-routing corpus", () => {
  test("#when rendered #then every denominator precedes the first rate with known counts", () => {
    const report = generateIntentRoutingReport(corpusDir)
    const expected = {
      turns_seen: 20,
      turns_gated_out: 3,
      turns_synthetic: 1,
      records_created: 20,
      records_with_prediction: 14,
      records_sealed_by_next_turn: 4,
      records_sealed_by_session_idle: 4,
      records_sealed_by_seal_timeout: 3,
      records_sealed_by_dispose: 3,
      records_sealed_by_session_deleted: 3,
      records_evicted: 2,
      in_flight: 1,
      orphan_observations: 3,
      unscorable_resume_calls: 2,
      resume_only_records: 1,
      unscorable_unknown_calls: 1,
      unknown_only_records: 1,
      unrepresentable_route_mismatches: 1,
      dispatches_dropped: 4,
      invalid_answers: 1,
      incoherent_predictions: 1,
      malformed_lines: 1,
      malformed_write_rejections: 5,
      records_lost_to_cap: 7,
      sink_truncations: 2,
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

    for (const [name, count] of Object.entries(expected)) {
      expect(report).toContain(`${name}: ${count}`)
    }
    expect(report.indexOf("turns_seen:")).toBeLessThan(report.indexOf("ROUTE AGREEMENT"))
    expect(report).toContain("records_created == sealed + evicted + in_flight: 20 == 17 + 2 + 1 [PASS]")
  })

  test("#when counters span epochs #then the newest sequence in the newest epoch supersedes older snapshots", () => {
    const report = generateIntentRoutingReport(corpusDir)

    expect(report).toContain("turns_seen: 20")
    expect(report).not.toContain("turns_seen: 920")
    expect(report).toContain("sink_truncations: 2")
  })

  test("#when headline eligibility is applied #then resume, unknown, invalid, and incoherent cases stay distinct", () => {
    const report = generateIntentRoutingReport(corpusDir)

    expect(report).toContain("route_agreement overall: 3/9 (33.33%)")
    expect(report).toContain("coherence overall: 10/11 (90.91%)")
    expect(report).toContain("resume_only_records: 1")
    expect(report).toContain("unknown_only_records: 1")
    expect(report).toContain("unrepresentable_route_mismatches: 1")
    expect(report).toContain("multi_route_turns_coverage_only: 2")
  })

  test("#when none is scored #then recall and precision use different conditioning sets", () => {
    const report = generateIntentRoutingReport(corpusDir)

    expect(report).toContain("none recall: 1/2 (50.00%)")
    expect(report).toContain("none precision: 1/4 (25.00%)")
  })

  test("#when mixed fan-out is covered #then turn and cardinality weighting differ", () => {
    const report = generateIntentRoutingReport(corpusDir)

    expect(report).toContain("category coverage unweighted: 2.50/6 (41.67%); distinct_target_cardinality=7")
    expect(report).toContain("category coverage cardinality_weighted: 3/7 (42.86%); distinct_target_cardinality=7")
    expect(report).toContain("subagent coverage unweighted: 1.33/2 (66.67%); distinct_target_cardinality=4")
    expect(report).toContain("subagent coverage cardinality_weighted: 2/4 (50.00%); distinct_target_cardinality=4")
  })

  test("#when cohorts are rendered #then all fan-out and sealed-by rows are explicit", () => {
    const report = generateIntentRoutingReport(corpusDir)

    for (const bucket of ["zero", "one", "many"] as const) {
      expect(report).toContain(`fan_out=${bucket}:`)
    }
    for (const sealedBy of ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const) {
      expect(report).toContain(`sealed_by=${sealedBy}:`)
    }
    expect(report).toContain("continuation_candidates: 1/1 (100.00%)")
  })

  test("#when fixture-only fields and recurrence context render #then their limits are explicit", () => {
    const report = generateIntentRoutingReport(corpusDir)

    expect(report).toContain("INTENT AND AMBIGUOUS: FIXTURE-SCORED ONLY, NO LIVE GROUND TRUTH")
    expect(report).toContain("full_prompt_sha256 recurrence counts:")
    expect(report).toContain("Non-goal: live disagreements are not reproducible from the retained 200-char prompt head; fixture growth is manual.")
  })
})

describe("#given an empty sink directory", () => {
  test("#when rendered #then denominators are zero and rates are insufficient data", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "jev-w1-empty-"))
    try {
      const report = generateIntentRoutingReport(emptyDir)
      expect(report).toContain("turns_seen: 0")
      expect(report).toContain("records_created: 0")
      expect(report).toContain("route_agreement overall: insufficient data (eligible denominator=0)")
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
