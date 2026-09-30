import { isRecord } from "./answer-validation"
import {
  readCompletionContinuationAnswer,
  unavailableCompletionContinuationAnswer,
  type CompletionContinuationAnswerObservation,
} from "./completion-continuation-answer-observation"
import {
  COMPLETION_CONTINUATION_QUESTIONS,
  COMPLETION_CONTINUATION_QUESTION_KEYS,
  COMPLETION_CONTINUATION_QUESTION_VERSION,
} from "./completion-continuation-questions"
import type {
  CompletionContinuationPredictionStatus,
  CompletionContinuationProbabilities,
  CompletionContinuationThresholdLabels,
} from "./completion-continuation-record-types"
import type { CompletionContinuationState } from "./completion-continuation-state"
import type { DecisionBackend, DecisionOutcome, DecisionUnavailableReason } from "./types"

export type CompletionContinuationTimer = {
  cancel(): void
}

export type CompletionContinuationClock = {
  now(): number
  schedule(delayMs: number, callback: () => void): CompletionContinuationTimer
}

export type CompletionContinuationDecisionStatus = Exclude<
  CompletionContinuationPredictionStatus,
  "not_dispatched"
>

export type CompletionContinuationDecisionResult = {
  readonly predictionStatus: CompletionContinuationDecisionStatus
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly probabilities: CompletionContinuationProbabilities
  readonly thresholdLabels: CompletionContinuationThresholdLabels
  readonly invalidAnswerCount: number
  readonly threshold: number
  readonly questionVersion: number
}

export type CompletionContinuationDecisionArgs = {
  readonly backend: DecisionBackend
  readonly state: CompletionContinuationState
  readonly confidenceThreshold: number
  readonly timeoutMs: number
  readonly model?: string
  readonly clock?: CompletionContinuationClock
}

const DEFAULT_CLOCK: CompletionContinuationClock = {
  now: () => performance.now(),
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs)
    handle.unref()
    return { cancel: () => clearTimeout(handle) }
  },
}

type CompletionContinuationAnswers = {
  readonly actuallyComplete: CompletionContinuationAnswerObservation
  readonly progressing: CompletionContinuationAnswerObservation
  readonly stuck: CompletionContinuationAnswerObservation
}

function unavailableAnswers(): CompletionContinuationAnswers {
  const unavailable = unavailableCompletionContinuationAnswer()
  return {
    actuallyComplete: unavailable,
    progressing: unavailable,
    stuck: unavailable,
  }
}

function toProbabilities(
  answers: CompletionContinuationAnswers,
): CompletionContinuationProbabilities {
  return {
    actuallyComplete: answers.actuallyComplete.probability,
    progressing: answers.progressing.probability,
    stuck: answers.stuck.probability,
  }
}

function toThresholdLabels(
  answers: CompletionContinuationAnswers,
): CompletionContinuationThresholdLabels {
  return {
    actuallyComplete: answers.actuallyComplete.label,
    progressing: answers.progressing.label,
    stuck: answers.stuck.label,
  }
}

function failedResult(args: {
  readonly status: "failed" | "timeout"
  readonly reason: DecisionUnavailableReason
  readonly latencyMs: number
  readonly threshold: number
}): CompletionContinuationDecisionResult {
  const answers = unavailableAnswers()
  return {
    predictionStatus: args.status,
    unavailableReason: args.reason,
    resolvedModel: null,
    latencyMs: args.latencyMs,
    probabilities: toProbabilities(answers),
    thresholdLabels: toThresholdLabels(answers),
    invalidAnswerCount: 0,
    threshold: args.threshold,
    questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION,
  }
}

function statusForReason(reason: DecisionUnavailableReason): "failed" | "timeout" {
  return reason === "timeout" ? "timeout" : "failed"
}

export async function decideCompletionContinuation(
  args: CompletionContinuationDecisionArgs,
): Promise<CompletionContinuationDecisionResult> {
  const clock = args.clock ?? DEFAULT_CLOCK
  const startedAt = clock.now()
  if (args.backend.kind === "disabled") {
    return failedResult({
      status: "failed",
      reason: "disabled",
      latencyMs: clock.now() - startedAt,
      threshold: args.confidenceThreshold,
    })
  }

  let timer: CompletionContinuationTimer | undefined
  try {
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = clock.schedule(args.timeoutMs, () => resolve({ kind: "timeout" }))
    })
    const backend = Promise.resolve()
      .then(() => args.backend.decide({
        state: JSON.parse(JSON.stringify(args.state)),
        questions: COMPLETION_CONTINUATION_QUESTIONS,
        model: args.model,
      }))
      .then((outcome) => ({ kind: "outcome", outcome }) as const)
    const raced = await Promise.race([backend, timeout])
    timer?.cancel()

    if (raced.kind === "timeout") {
      return failedResult({
        status: "timeout",
        reason: "timeout",
        latencyMs: clock.now() - startedAt,
        threshold: args.confidenceThreshold,
      })
    }

    const outcome: DecisionOutcome<typeof COMPLETION_CONTINUATION_QUESTIONS> = raced.outcome
    if (outcome.status === "unavailable") {
      return failedResult({
        status: statusForReason(outcome.reason),
        reason: outcome.reason,
        latencyMs: outcome.latencyMs,
        threshold: args.confidenceThreshold,
      })
    }

    const rawAnswers: unknown = outcome.answers
    const answerRecord = isRecord(rawAnswers) ? rawAnswers : {}
    const answers: CompletionContinuationAnswers = {
      actuallyComplete: readCompletionContinuationAnswer(
        COMPLETION_CONTINUATION_QUESTIONS.actually_complete,
        answerRecord.actually_complete,
        args.confidenceThreshold,
      ),
      progressing: readCompletionContinuationAnswer(
        COMPLETION_CONTINUATION_QUESTIONS.progressing,
        answerRecord.progressing,
        args.confidenceThreshold,
      ),
      stuck: readCompletionContinuationAnswer(
        COMPLETION_CONTINUATION_QUESTIONS.stuck,
        answerRecord.stuck,
        args.confidenceThreshold,
      ),
    }
    const unexpectedAnswerCount = Object.keys(answerRecord)
      .filter((key) => !COMPLETION_CONTINUATION_QUESTION_KEYS.some((expected) => expected === key))
      .length
    const invalidAnswerCount = Object.values(answers)
      .filter((answer) => !answer.valid).length + unexpectedAnswerCount

    return {
      predictionStatus: invalidAnswerCount === 0 ? "filled" : "failed",
      unavailableReason: invalidAnswerCount === 0 ? null : "malformed_response",
      resolvedModel: outcome.model,
      latencyMs: outcome.latencyMs,
      probabilities: toProbabilities(answers),
      thresholdLabels: toThresholdLabels(answers),
      invalidAnswerCount,
      threshold: args.confidenceThreshold,
      questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION,
    }
  } catch {
    timer?.cancel()
    return failedResult({
      status: "failed",
      reason: "transport_error",
      latencyMs: clock.now() - startedAt,
      threshold: args.confidenceThreshold,
    })
  }
}
