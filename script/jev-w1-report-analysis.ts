import type { IntentRoutingCounters } from "../packages/jev-core/src"
import type { IntentRoutingSinkReadResult } from "../packages/omo-opencode/src/features/jev/intent-routing-reader"
import {
  agreement,
  coherence,
  coverage,
  headlineBase,
  isAgreementCorrect,
  nonePrecision,
  noneRecall,
  prepareRecord,
} from "./jev-w1-report-scoring"
import { FAN_OUT_BUCKETS, SEALED_BY_VALUES, type ReportAnalysis } from "./jev-w1-report-types"

class IntentRoutingCounterIdentityError extends Error {
  constructor(created: number, sealed: number, evicted: number) {
    super(`Counter identity failed: records_created=${created}, sealed=${sealed}, records_evicted=${evicted}`)
    this.name = "IntentRoutingCounterIdentityError"
  }
}

function emptyCounters(): IntentRoutingCounters {
  return {
    turnsSeen: 0, turnsGatedOut: 0, turnsSynthetic: 0, recordsCreated: 0,
    recordsEvicted: 0, orphanObservations: 0, unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0, dispatchesDropped: 0, malformedWriteRejections: 0,
    recordsLostToCap: 0, sinkTruncations: 0,
  }
}

function addCounters(total: IntentRoutingCounters, next: IntentRoutingCounters): IntentRoutingCounters {
  return {
    turnsSeen: total.turnsSeen + next.turnsSeen,
    turnsGatedOut: total.turnsGatedOut + next.turnsGatedOut,
    turnsSynthetic: total.turnsSynthetic + next.turnsSynthetic,
    recordsCreated: total.recordsCreated + next.recordsCreated,
    recordsEvicted: total.recordsEvicted + next.recordsEvicted,
    orphanObservations: total.orphanObservations + next.orphanObservations,
    unscorableResumeCalls: total.unscorableResumeCalls + next.unscorableResumeCalls,
    unscorableUnknownCalls: total.unscorableUnknownCalls + next.unscorableUnknownCalls,
    dispatchesDropped: total.dispatchesDropped + next.dispatchesDropped,
    malformedWriteRejections: total.malformedWriteRejections + next.malformedWriteRejections,
    recordsLostToCap: total.recordsLostToCap + next.recordsLostToCap,
    sinkTruncations: total.sinkTruncations + next.sinkTruncations,
  }
}

export function analyzeIntentRoutingSink(sink: IntentRoutingSinkReadResult): ReportAnalysis {
  let counters = emptyCounters()
  for (const entry of sink.latestCountersByProcess.values()) counters = addCounters(counters, entry.counters)
  const prepared = sink.observations.map(prepareRecord)
  const base = headlineBase(prepared)
  const sealedCounts = {
    next_turn: sink.observations.filter((record) => record.sealedBy === "next_turn").length,
    session_idle: sink.observations.filter((record) => record.sealedBy === "session_idle").length,
    seal_timeout: sink.observations.filter((record) => record.sealedBy === "seal_timeout").length,
    dispose: sink.observations.filter((record) => record.sealedBy === "dispose").length,
    session_deleted: sink.observations.filter((record) => record.sealedBy === "session_deleted").length,
  } satisfies Record<(typeof SEALED_BY_VALUES)[number], number>
  const sealed = sink.observations.length
  const inFlight = counters.recordsCreated - sealed - counters.recordsEvicted
  if (inFlight < 0) throw new IntentRoutingCounterIdentityError(counters.recordsCreated, sealed, counters.recordsEvicted)

  const denominators: Record<string, number> = {
    turns_seen: counters.turnsSeen,
    turns_gated_out: counters.turnsGatedOut,
    turns_synthetic: counters.turnsSynthetic,
    records_created: counters.recordsCreated,
    records_with_prediction: sink.observations.filter((record) => record.predictionStatus === "filled").length,
    records_sealed_by_next_turn: sealedCounts.next_turn,
    records_sealed_by_session_idle: sealedCounts.session_idle,
    records_sealed_by_seal_timeout: sealedCounts.seal_timeout,
    records_sealed_by_dispose: sealedCounts.dispose,
    records_sealed_by_session_deleted: sealedCounts.session_deleted,
    records_evicted: counters.recordsEvicted,
    in_flight: inFlight,
    orphan_observations: counters.orphanObservations,
    unscorable_resume_calls: counters.unscorableResumeCalls,
    resume_only_records: prepared.filter((item) => item.resumeOnly).length,
    unscorable_unknown_calls: counters.unscorableUnknownCalls,
    unknown_only_records: prepared.filter((item) => item.unknownOnly).length,
    unrepresentable_route_mismatches: prepared.reduce((sum, item) => sum + item.record.observed.filter((entry) => entry.routeClass === "unknown").length, 0),
    dispatches_dropped: counters.dispatchesDropped,
    invalid_answers: sink.observations.reduce((sum, record) => sum + record.invalidAnswerCount, 0),
    incoherent_predictions: prepared.filter((item) => item.record.predictionStatus === "filled" && !item.coherent).length,
    malformed_lines: sink.malformedLines,
    malformed_write_rejections: counters.malformedWriteRejections,
    records_lost_to_cap: counters.recordsLostToCap,
    sink_truncations: counters.sinkTruncations,
    prediction_reused: sink.observations.filter((record) => record.predictionReused).length,
    truncated_input: sink.observations.filter((record) => record.truncatedInput).length,
  }
  for (const status of ["filled", "failed", "timeout", "not_dispatched"] as const) {
    denominators[`prediction_status_${status}`] = sink.observations.filter((record) => record.predictionStatus === status).length
  }
  for (const status of ["reliable", "censored", "overlap_ambiguous"] as const) {
    denominators[`correlation_status_${status}`] = sink.observations.filter((record) => record.correlationStatus === status).length
  }

  const fanOutAgreement = {
    zero: agreement(base.filter((item) => item.record.fanOutBucket === "zero")),
    one: agreement(base.filter((item) => item.record.fanOutBucket === "one")),
    many: agreement(base.filter((item) => item.record.fanOutBucket === "many")),
  } satisfies ReportAnalysis["fanOutAgreement"]
  const sealedByAgreement = {
    next_turn: agreement(base.filter((item) => item.record.sealedBy === "next_turn")),
    session_idle: agreement(base.filter((item) => item.record.sealedBy === "session_idle")),
    seal_timeout: agreement(base.filter((item) => item.record.sealedBy === "seal_timeout")),
    dispose: agreement(base.filter((item) => item.record.sealedBy === "dispose")),
    session_deleted: agreement(base.filter((item) => item.record.sealedBy === "session_deleted")),
  } satisfies ReportAnalysis["sealedByAgreement"]
  const disagreements = base.filter((item) => item.effectiveRoutes.size <= 1 && !isAgreementCorrect(item))
  const disagreementShaCounts = new Map<string, number>()
  for (const item of disagreements) {
    const sha = item.record.promptFullSha256
    disagreementShaCounts.set(sha, (disagreementShaCounts.get(sha) ?? 0) + 1)
  }
  return {
    denominators,
    identity: { created: counters.recordsCreated, sealed, evicted: counters.recordsEvicted, inFlight },
    routeAgreement: agreement(base),
    coherence: coherence(base),
    noneRecall: noneRecall(base),
    nonePrecision: nonePrecision(base),
    categoryCoverage: coverage(base, "category"),
    subagentCoverage: coverage(base, "subagent"),
    multiRouteTurns: base.filter((item) => item.effectiveRoutes.size >= 2).length,
    fanOutAgreement,
    sealedByAgreement,
    continuationAgreement: agreement(base.filter((item) => item.record.isContinuationCandidate)),
    disagreementShaCounts,
  }
}
