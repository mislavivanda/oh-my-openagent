// allow: SIZE_OK - one synthetic-corpus acceptance suite pins the report's conditioning rules together.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  validateIntentRoutingObservationRecord,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import { writeSyntheticCorpus } from "./jev-w1-report.fixtures"
import { generateJevW1Report } from "./jev-w1-report"

let corpusRoot = ""
let report = ""

function denominator(name: string): number {
  const match = new RegExp(`^${name}: (\\d+)$`, "m").exec(report)
  expect(match).not.toBeNull()
  return Number(match?.[1] ?? Number.NaN)
}

function seedObservation(): IntentRoutingObservationRecord {
  for (const filename of readdirSync(corpusRoot).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(corpusRoot, filename), "utf8").split("\n")) {
      if (line.length === 0) continue
      const parsed: unknown = JSON.parse(line)
      if (validateIntentRoutingObservationRecord(parsed)) return parsed
    }
  }
  throw new Error("Synthetic report corpus has no observation")
}

function writeCounterCorpus(
  directory: string,
  beforeCounter: readonly IntentRoutingObservationRecord[],
  afterCounter: readonly IntentRoutingObservationRecord[],
  recordsCreated: number,
  recordsInFlight: number,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const counterDelta = {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-24T12:00:01.000Z",
    processId: "identity-process",
    counterEpoch: 0,
    monotonicSeq: 1,
    counters: {
      turnsSeen: recordsCreated,
      turnsGatedOut: 0,
      turnsSynthetic: 0,
      recordsCreated,
      recordsInFlight,
      recordsEvicted: 0,
      orphanObservations: 0,
      unscorableResumeCalls: 0,
      unscorableUnknownCalls: 0,
      dispatchesDropped: 0,
      malformedWriteRejections: 0,
      recordsLostToCap: 0,
      sinkTruncations: 0,
    },
  }
  const entries = [...beforeCounter, counterDelta, ...afterCounter]
  writeFileSync(
    join(directory, "w1-20260924-identity-process.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600 },
  )
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

  test("#given observations newer than the latest counter snapshot #when the report renders #then row totals reconcile the stale snapshot without throwing", () => {
    const staleRoot = mkdtempSync(join(tmpdir(), "jev-w1-report-stale-"))
    const first = seedObservation()
    const second = {
      ...first,
      turnOrdinal: first.turnOrdinal + 1,
      dedupKey: `${first.dedupKey}-later`,
      reuseKey: `${first.reuseKey}-later`,
    }
    writeCounterCorpus(staleRoot, [first], [second], 1, 0)

    try {
      const staleReport = generateJevW1Report(staleRoot)

      expect(staleReport).toContain("records_created: 2")
      expect(staleReport).toContain("counter_reconciliation: records_created snapshot(1) raised to row_floor(2)")
      expect(staleReport).toContain("identity: records_created(2) == sealed(2) + evicted(0) + in_flight(0)")
    } finally {
      rmSync(staleRoot, { recursive: true, force: true })
    }
  })

  test("#given a counter snapshot that overstates creation #when identity is checked #then independent in-flight stays zero and the discrepancy is reported", () => {
    const mismatchRoot = mkdtempSync(join(tmpdir(), "jev-w1-report-mismatch-"))
    writeCounterCorpus(mismatchRoot, [seedObservation()], [], 2, 0)

    try {
      const mismatchReport = generateJevW1Report(mismatchRoot)

      expect(mismatchReport).toContain("records_created: 2")
      expect(mismatchReport).toContain("records_in_flight: 0")
      expect(mismatchReport).toContain("identity: MISMATCH records_created(2) != sealed(1) + evicted(0) + in_flight(0) = 1")
    } finally {
      rmSync(mismatchRoot, { recursive: true, force: true })
    }
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

  test("#given none-heavy fixture labels #when per-question figures render #then majority-class base rates disclose the constant-none baseline", () => {
    expect(report).toContain("category_fixture_majority_class_base_rate: none 8/15 = 53.33%")
    expect(report).toContain("subagent_fixture_majority_class_base_rate: none 13/15 = 86.67%")
    expect(report).toContain("combined_category_subagent_fixture_majority_class_base_rate: none 21/30 = 70.00%")
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
