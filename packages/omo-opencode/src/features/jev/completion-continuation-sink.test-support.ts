import {
  COMPLETION_CONTINUATION_QUESTION_VERSION,
  type CompletionContinuationCounterDelta,
  type CompletionContinuationCounters,
  type CompletionContinuationObservation,
  type CompletionContinuationPreInputSkips,
} from "@oh-my-opencode/jev-core"
import type { CompletionContinuationProcessIdentity } from "./completion-continuation-sink"
import { observationProcessId } from "./observation-process-identity"

export const W2_FIXED_NOW = Date.parse("2026-09-30T12:00:00.000Z")

export function completionContinuationPreInputSkips(): CompletionContinuationPreInputSkips {
  return {
    alreadyComplete: 0,
    recovering: 0,
    cancelled: 0,
    syncHandoff: 0,
    tokenLimit: 0,
    recentAbort: 0,
    backgroundTasks: 0,
    assistantAborted: 0,
    pendingQuestion: 0,
    internalContinuationPending: 0,
    messagesUnavailable: 0,
    todosUnavailable: 0,
  }
}

export function completionContinuationCounters(
  overrides: Partial<CompletionContinuationCounters> = {},
): CompletionContinuationCounters {
  return {
    starts: 0,
    preInputSkips: completionContinuationPreInputSkips(),
    dispatchesDropped: 0,
    recordsEvicted: 0,
    censoredWindows: 0,
    malformedLines: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
    ...overrides,
  }
}

export function completionContinuationObservation(
  overrides: Partial<CompletionContinuationObservation> = {},
): CompletionContinuationObservation {
  return {
    kind: "observation",
    schemaVersion: 1,
    questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION,
    recordedAt: "2026-09-30T12:00:00.000Z",
    sessionID: "ses_w2",
    ordinal: 1,
    counterEpoch: 0,
    inputDigests: {
      todoStatus: "sha256:todos",
      transcript: "sha256:transcript",
      diff: "sha256:diff",
      boulder: "sha256:boulder",
    },
    inputTruncations: {
      todoItems: false,
      todoContent: false,
      transcriptMessages: false,
      transcriptContent: false,
      diffPaths: false,
      diffContent: false,
      boulderContent: false,
      state: false,
    },
    isContinuationCandidate: true,
    probabilities: { actuallyComplete: 0.1, progressing: 0.2, stuck: 0.9 },
    thresholdLabels: {
      actuallyComplete: "would_false",
      progressing: "would_false",
      stuck: "would_true",
    },
    confidenceThreshold: 0.8,
    heuristicFacts: {
      gauntletOutcome: "continuation_scheduled",
      todoComplete: false,
      promiseComplete: false,
      todoProgress: false,
      stagnationStop: false,
    },
    outcomeFacts: { actuallyComplete: false, progressing: false, stuck: true },
    outcomeStatus: "observed",
    outcomeClosedBy: "unchanged_next_idle",
    predictionStatus: "filled",
    notDispatchedReason: null,
    unavailableReason: null,
    resolvedModel: "typesafe/jev-1.13.0",
    latencyMs: 42,
    invalidAnswerCount: 0,
    ...overrides,
  }
}

export function completionContinuationProcessIdentity(
  pid: number,
): CompletionContinuationProcessIdentity {
  return {
    pid,
    processStartEpochNanos: `${1_790_000_000_000_000_000n + BigInt(pid)}`,
    randomSuffix: `w2suffix${pid}`,
  }
}

export function completionContinuationCounterDelta(
  identity: CompletionContinuationProcessIdentity,
  monotonicSeq: number,
  values: CompletionContinuationCounters,
  counterEpoch = 0,
): CompletionContinuationCounterDelta {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: "2026-09-30T12:00:00.000Z",
    processId: observationProcessId(identity),
    counterEpoch,
    monotonicSeq,
    counters: values,
  }
}
