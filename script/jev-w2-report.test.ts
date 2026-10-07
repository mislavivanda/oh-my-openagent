import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  COMPLETION_CONTINUATION_CENSORED_CLOSURES,
  COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES,
  COMPLETION_CONTINUATION_OBSERVED_CLOSURES,
  COMPLETION_CONTINUATION_PREDICTION_STATUSES,
} from "../packages/jev-core/src"
import { JevCompletionContinuationWireConfigSchema } from "../packages/omo-opencode/src/config/schema/jev"
import { readCompletionContinuationSink } from "../packages/omo-opencode/src/features/jev/completion-continuation-reader"
import { analyzeCompletionContinuationSink } from "./jev-w2-report-analysis"
import { writeJevW2SyntheticCorpus } from "./jev-w2-report.fixtures"
import { generateCompletionContinuationReport } from "./jev-w2-report"

const SCHEMA_OUTCOME_WINDOW_MS =
  JevCompletionContinuationWireConfigSchema.parse({}).outcome_window_ms

let corpusDir = ""

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), "jev-w2-report-"))
  writeJevW2SyntheticCorpus(corpusDir)
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

describe("#given an exhaustive completion-continuation corpus", () => {
  test("#when rendered #then denominators precede every agreement rate", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    expect(report.indexOf("DENOMINATORS")).toBeLessThan(report.indexOf("HEURISTIC PROXY AGREEMENT"))
    expect(report.indexOf("HEURISTIC PROXY AGREEMENT")).toBeLessThan(report.indexOf("OUTCOME AGREEMENT"))
    for (const status of COMPLETION_CONTINUATION_PREDICTION_STATUSES) {
      expect(report).toContain(`prediction_status_${status}:`)
    }
    for (const outcome of COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES) {
      expect(report).toContain(`gauntlet_outcome_${outcome}: 1`)
    }
    for (const closure of [
      ...COMPLETION_CONTINUATION_OBSERVED_CLOSURES,
      ...COMPLETION_CONTINUATION_CENSORED_CLOSURES,
    ]) {
      expect(report).toContain(`outcome_closure_${closure}:`)
    }
    for (const name of [
      "starts: 15", "records: 13", "invalid_answers: 3", "uncertain_answers:",
      "dispatches_dropped: 4", "records_evicted: 3", "malformed_lines: 6",
      "malformed_write_rejections: 4", "records_lost_to_cap: 5", "sink_truncations: 3",
      "diff_available:", "boulder_available:", "in_flight: 2",
    ]) expect(report).toContain(name)
    expect(report).toContain("in_flight_identity: starts=15 records=13 in_flight=2 balanced=yes")
    for (const [name, count] of Object.entries({
      prediction_status_filled: 10,
      prediction_status_failed: 1,
      prediction_status_timeout: 1,
      prediction_status_not_dispatched: 1,
      outcome_status_pending: 2,
      outcome_status_observed: 6,
      outcome_status_censored: 5,
      uncertain_answers: 9,
      transcript_available: 7,
      transcript_unavailable: 6,
      diff_available: 5,
      diff_unavailable: 8,
      boulder_available: 4,
      boulder_unavailable: 9,
    })) expect(report).toContain(`${name}: ${count}`)
    for (const reason of COMPLETION_CONTINUATION_CENSORED_CLOSURES) {
      expect(report).toContain(`censor_reason_${reason}: 1`)
    }
  })

  test("#when rendered #then the outcome observation window precedes every denominator and rate", () => {
    const report = generateCompletionContinuationReport(corpusDir)
    const windowIndex = report.indexOf(`outcome_window_ms: ${SCHEMA_OUTCOME_WINDOW_MS} (config schema default)`)

    expect(SCHEMA_OUTCOME_WINDOW_MS).toBe(120000)
    expect(windowIndex).toBeGreaterThanOrEqual(0)
    expect(windowIndex).toBeLessThan(report.indexOf("DENOMINATORS"))
    expect(windowIndex).toBeLessThan(report.indexOf("HEURISTIC PROXY AGREEMENT"))
    expect(windowIndex).toBeLessThan(report.indexOf("OUTCOME AGREEMENT"))
    expect(report).toContain("observation records carry no window value")
  })

  test("#when heuristic proxies and later outcomes diverge #then their rates remain separate", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    for (const metric of ["todo_complete", "promise_complete", "todo_progress", "stagnation_stop"]) {
      expect(report).toContain(`${metric} overall: 2/2 (100.00%); coverage=2/13`)
    }
    for (const question of ["actually_complete", "progressing", "stuck"]) {
      expect(report).toContain(`${question} cohort=autonomous overall: 4/5 (80.00%); coverage=5/6`)
      expect(report).toContain(`${question} cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/1`)
    }
  })

  test("#when censored records predict stuck #then they never enter the stuck denominator", () => {
    const analysis = analyzeCompletionContinuationSink(readCompletionContinuationSink(corpusDir))
    const autonomousStuck = analysis.outcomeAgreement.autonomous.stuck

    expect(autonomousStuck.overall.denominator).toBe(5)
    for (const cohort of ["human_interactive", "timeout", "dispose", "session_deleted", "evicted"] as const) {
      expect(analysis.outcomeAgreement[cohort].stuck.overall.denominator).toBe(0)
    }
  })

  test("#when autonomous and human-interactive records coexist #then each cohort has its own denominator", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    for (const [cohort, count] of Object.entries({
      autonomous: 6,
      human_interactive: 1,
      timeout: 1,
      dispose: 1,
      session_deleted: 1,
      evicted: 1,
      pending: 2,
    })) {
      expect(report).toContain(`outcome_cohort_${cohort}: ${count}`)
      expect(report).toContain(`OUTCOME COHORT ${cohort}`)
    }
  })

  test("#when every availability and truncation bucket is present #then each count is explicit", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    for (const signal of ["transcript", "diff", "boulder"]) {
      expect(report).toContain(`${signal}_available:`)
      expect(report).toContain(`${signal}_unavailable:`)
    }
    for (const flag of [
      "todo_items", "todo_content", "transcript_messages", "transcript_content",
      "diff_paths", "diff_content", "boulder_content", "state",
    ]) expect(report).toContain(`truncation_flag_${flag}:`)
    expect(report).toContain("continuation_fixture_cohort=candidate:")
    expect(report).toContain("continuation_fixture_cohort=non_candidate:")
  })

  test("#when malformed and truncated lines are read #then they are counted without stopping the report", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    expect(report).toContain("malformed_lines: 6")
    expect(report).toContain("outcome_closure_pending: 2")
    expect(report).toContain("OUTCOME AGREEMENT BY COHORT (observed non-censored labels only)")
  })

  test("#when counter epochs and sequences regress #then only the highest tuple contributes", () => {
    const report = generateCompletionContinuationReport(corpusDir)

    expect(report).toContain("starts: 15")
    expect(report).not.toContain("starts: 791")
    expect(report).not.toContain("starts: 1003")
  })
})

describe("#given an empty completion-continuation corpus", () => {
  test("#when rendered #then zero denominators produce insufficient data", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "jev-w2-empty-"))
    try {
      const report = generateCompletionContinuationReport(emptyDir)
      expect(report).toContain("starts: 0")
      expect(report).toContain("records: 0")
      expect(report).toContain(`outcome_window_ms: ${SCHEMA_OUTCOME_WINDOW_MS} (config schema default)`)
      expect(report).toContain("insufficient data (eligible denominator=0); coverage=0/0")
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
