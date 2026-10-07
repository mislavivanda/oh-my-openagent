import { isRecord, validateAnswer } from "./answer-validation"
import type { CompletionContinuationThresholdLabel } from "./completion-continuation-record-types"
import type { NoulQuestion } from "./types"

export type CompletionContinuationAnswerObservation = {
  readonly probability: number | null
  readonly valid: boolean
  readonly label: CompletionContinuationThresholdLabel
}

function hasExactNoulKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === 2 && keys.includes("type") && keys.includes("noul")
}

export function labelCompletionContinuationProbability(
  probability: number,
  threshold: number,
): Exclude<CompletionContinuationThresholdLabel, "unavailable"> {
  if (probability >= threshold) return "would_true"
  if (probability <= 1 - threshold) return "would_false"
  return "uncertain"
}

export function readCompletionContinuationAnswer(
  question: NoulQuestion,
  raw: unknown,
  threshold: number,
): CompletionContinuationAnswerObservation {
  if (!isRecord(raw) || !hasExactNoulKeys(raw) || !validateAnswer(question, raw)) {
    return { probability: null, valid: false, label: "unavailable" }
  }

  return {
    probability: raw.noul,
    valid: true,
    label: labelCompletionContinuationProbability(raw.noul, threshold),
  }
}

export function unavailableCompletionContinuationAnswer(): CompletionContinuationAnswerObservation {
  return { probability: null, valid: false, label: "unavailable" }
}
