import {
  COMPLETION_CONTINUATION_CENSORED_CLOSURES,
  COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES,
  COMPLETION_CONTINUATION_OBSERVED_CLOSURES,
  COMPLETION_CONTINUATION_PREDICTION_STATUSES,
  COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS,
  type CompletionContinuationCounters,
} from "../packages/jev-core/src"
import type { CompletionContinuationSinkReadResult } from "../packages/omo-opencode/src/features/jev/completion-continuation-reader"
import {
  HEURISTIC_AGREEMENT_SPECS,
  OUTCOME_AGREEMENT_SPECS,
  scoreCompletionContinuationAgreement,
} from "./jev-w2-report-scoring"
import type { CompletionContinuationReportAnalysis } from "./jev-w2-report-types"

function emptyCounters(): CompletionContinuationCounters {
  return {
    starts: 0,
    preInputSkips: {
      alreadyComplete: 0, recovering: 0, cancelled: 0, syncHandoff: 0,
      tokenLimit: 0, recentAbort: 0, backgroundTasks: 0, assistantAborted: 0,
      pendingQuestion: 0, internalContinuationPending: 0,
      messagesUnavailable: 0, todosUnavailable: 0,
    },
    dispatchesDropped: 0,
    recordsEvicted: 0,
    censoredWindows: 0,
    malformedLines: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
}

function addCounters(
  total: CompletionContinuationCounters,
  next: CompletionContinuationCounters,
): CompletionContinuationCounters {
  const skips = Object.fromEntries(COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS.map((reason) => [
    reason,
    total.preInputSkips[reason] + next.preInputSkips[reason],
  ]))
  return {
    starts: total.starts + next.starts,
    preInputSkips: {
      alreadyComplete: skips.alreadyComplete ?? 0,
      recovering: skips.recovering ?? 0,
      cancelled: skips.cancelled ?? 0,
      syncHandoff: skips.syncHandoff ?? 0,
      tokenLimit: skips.tokenLimit ?? 0,
      recentAbort: skips.recentAbort ?? 0,
      backgroundTasks: skips.backgroundTasks ?? 0,
      assistantAborted: skips.assistantAborted ?? 0,
      pendingQuestion: skips.pendingQuestion ?? 0,
      internalContinuationPending: skips.internalContinuationPending ?? 0,
      messagesUnavailable: skips.messagesUnavailable ?? 0,
      todosUnavailable: skips.todosUnavailable ?? 0,
    },
    dispatchesDropped: total.dispatchesDropped + next.dispatchesDropped,
    recordsEvicted: total.recordsEvicted + next.recordsEvicted,
    censoredWindows: total.censoredWindows + next.censoredWindows,
    malformedLines: total.malformedLines + next.malformedLines,
    malformedWriteRejections: total.malformedWriteRejections + next.malformedWriteRejections,
    recordsLostToCap: total.recordsLostToCap + next.recordsLostToCap,
    sinkTruncations: total.sinkTruncations + next.sinkTruncations,
  }
}

const TRUNCATION_DENOMINATORS = [
  ["todo_items", "todoItems"],
  ["todo_content", "todoContent"],
  ["transcript_messages", "transcriptMessages"],
  ["transcript_content", "transcriptContent"],
  ["diff_paths", "diffPaths"],
  ["diff_content", "diffContent"],
  ["boulder_content", "boulderContent"],
  ["state", "state"],
] as const

export function analyzeCompletionContinuationSink(
  sink: CompletionContinuationSinkReadResult,
): CompletionContinuationReportAnalysis {
  let counters = emptyCounters()
  for (const entry of sink.latestCountersByProcess.values()) {
    counters = addCounters(counters, entry.counters)
  }
  const records = sink.observations
  const denominators: Record<string, number> = {
    starts: counters.starts,
    records: records.length,
  }
  for (const status of COMPLETION_CONTINUATION_PREDICTION_STATUSES) {
    denominators[`prediction_status_${status}`] = records.filter((record) => record.predictionStatus === status).length
  }
  denominators.invalid_answers = records.reduce((sum, record) => sum + record.invalidAnswerCount, 0)
  denominators.uncertain_answers = records.reduce((sum, record) =>
    sum + Object.values(record.thresholdLabels).filter((label) => label === "uncertain").length, 0)
  for (const outcome of COMPLETION_CONTINUATION_GAUNTLET_OUTCOMES) {
    denominators[`gauntlet_outcome_${outcome}`] = records.filter((record) => record.heuristicFacts.gauntletOutcome === outcome).length
  }
  for (const status of ["pending", "observed", "censored"] as const) {
    denominators[`outcome_status_${status}`] = records.filter((record) => record.outcomeStatus === status).length
  }
  denominators.outcome_closure_pending = records.filter((record) => record.outcomeClosedBy === null).length
  for (const closure of [
    ...COMPLETION_CONTINUATION_OBSERVED_CLOSURES,
    ...COMPLETION_CONTINUATION_CENSORED_CLOSURES,
  ]) {
    denominators[`outcome_closure_${closure}`] = records.filter((record) => record.outcomeClosedBy === closure).length
  }
  for (const reason of COMPLETION_CONTINUATION_CENSORED_CLOSURES) {
    denominators[`censor_reason_${reason}`] = records.filter((record) => record.outcomeStatus === "censored" && record.outcomeClosedBy === reason).length
  }
  for (const reason of COMPLETION_CONTINUATION_PRE_INPUT_SKIP_REASONS) {
    denominators[`pre_input_skip_${reason}`] = counters.preInputSkips[reason]
  }
  Object.assign(denominators, {
    dispatches_dropped: counters.dispatchesDropped,
    records_evicted: counters.recordsEvicted,
    censored_windows: counters.censoredWindows,
    malformed_lines: sink.malformedLines + counters.malformedLines,
    malformed_write_rejections: counters.malformedWriteRejections,
    records_lost_to_cap: counters.recordsLostToCap,
    sink_truncations: counters.sinkTruncations,
  })
  for (const [label, key] of TRUNCATION_DENOMINATORS) {
    denominators[`truncation_flag_${label}`] = records.filter((record) => record.inputTruncations[key]).length
  }
  for (const signal of ["transcript", "diff", "boulder"] as const) {
    denominators[`${signal}_available`] = records.filter((record) => record.inputDigests[signal] !== null).length
    denominators[`${signal}_unavailable`] = records.filter((record) => record.inputDigests[signal] === null).length
  }
  denominators.continuation_fixture_cohort_candidate = records.filter((record) => record.isContinuationCandidate).length
  denominators.continuation_fixture_cohort_non_candidate = records.filter((record) => !record.isContinuationCandidate).length
  const inFlight = Math.max(0, counters.starts - records.length)
  denominators.in_flight = inFlight
  return {
    denominators,
    identity: {
      starts: counters.starts,
      records: records.length,
      inFlight,
      balanced: counters.starts === records.length + inFlight,
    },
    heuristicAgreement: {
      todoComplete: scoreCompletionContinuationAgreement(records, HEURISTIC_AGREEMENT_SPECS.todoComplete),
      promiseComplete: scoreCompletionContinuationAgreement(records, HEURISTIC_AGREEMENT_SPECS.promiseComplete),
      todoProgress: scoreCompletionContinuationAgreement(records, HEURISTIC_AGREEMENT_SPECS.todoProgress),
      stagnationStop: scoreCompletionContinuationAgreement(records, HEURISTIC_AGREEMENT_SPECS.stagnationStop),
    },
    outcomeAgreement: {
      actuallyComplete: scoreCompletionContinuationAgreement(records, OUTCOME_AGREEMENT_SPECS.actuallyComplete),
      progressing: scoreCompletionContinuationAgreement(records, OUTCOME_AGREEMENT_SPECS.progressing),
      stuck: scoreCompletionContinuationAgreement(records, OUTCOME_AGREEMENT_SPECS.stuck),
    },
  }
}
