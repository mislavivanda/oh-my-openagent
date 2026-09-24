import type { DecisionUnavailableReason } from "./types"

export const INTENT_ROUTING_SCHEMA_VERSION = 1 as const
export const INTENT_ROUTING_PROMPT_HEAD_MAX_CHARS = 200

export const INTENT_ROUTING_CONTINUATION_LEXICON = Object.freeze([
  "continue",
  "go on",
  "go ahead",
  "keep going",
  "next",
  "proceed",
  "resume",
  "yes",
  "ok",
  "do it",
  "carry on",
  "more",
] as const)

const continuationPhrases = new Set<string>(INTENT_ROUTING_CONTINUATION_LEXICON)

export function isIntentRoutingContinuationCandidate(normalizedPrompt: string): boolean {
  const withoutTrailingPunctuation = normalizedPrompt.replace(/\p{P}+$/gu, "").trimEnd()
  if (withoutTrailingPunctuation.length === 0) return false

  const tokenCount = withoutTrailingPunctuation.split(/\s+/u).length
  return tokenCount <= 4 && continuationPhrases.has(withoutTrailingPunctuation)
}

export type IntentRoutingPredictionStatus = "filled" | "failed" | "timeout" | "not_dispatched"
export type IntentRoutingFanOutBucket = "zero" | "one" | "many"
export type IntentRoutingCorrelationStatus = "reliable" | "censored" | "overlap_ambiguous"
export type IntentRoutingSealedBy =
  | "next_turn"
  | "session_idle"
  | "seal_timeout"
  | "dispose"
  | "session_deleted"

export type IntentRoutingRouteClass =
  | "none"
  | "category"
  | "subagent"
  | "unscorable_resume"
  | "unknown"

export type IntentRoutingChoiceAnswer = {
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly valid: boolean
}

export type IntentRoutingNoulAnswer = {
  readonly noul: number
  readonly valid: boolean
}

export type IntentRoutingAnswers = {
  readonly intent: IntentRoutingChoiceAnswer
  readonly category: IntentRoutingChoiceAnswer
  readonly subagent: IntentRoutingChoiceAnswer
  readonly ambiguous: IntentRoutingNoulAnswer
}

export type IntentRoutingObservedDelegation = {
  readonly tool: "task" | "call_omo_agent"
  readonly category: string | null
  readonly subagentType: string | null
  readonly requestedSubagentType: string | null
  readonly taskId: string | null
  readonly normalizedCategory: string
  readonly normalizedSubagent: string
  readonly routeClass: IntentRoutingRouteClass
  readonly callID: string
}

export type IntentRoutingObservationRecord = {
  readonly kind: "observation"
  readonly schemaVersion: typeof INTENT_ROUTING_SCHEMA_VERSION
  readonly questionVersion: number
  readonly recordedAt: string
  readonly sessionID: string
  readonly turnOrdinal: number
  readonly dedupKey: string
  readonly reuseKey: string
  readonly predictionReused: boolean
  readonly promptHeadChars: string
  readonly promptFullSha256: string
  readonly promptChars: number
  readonly truncatedInput: boolean
  readonly isContinuationCandidate: boolean
  readonly predictionStatus: IntentRoutingPredictionStatus
  readonly notDispatchedReason: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly answers: IntentRoutingAnswers | null
  readonly invalidAnswerCount: number
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly observedAreAttempts: true
  readonly distinctCategoryCount: number
  readonly distinctSubagentCount: number
  readonly fanOutBucket: IntentRoutingFanOutBucket
  readonly correlationStatus: IntentRoutingCorrelationStatus
  readonly sealedBy: IntentRoutingSealedBy
  readonly counterEpoch: number
}

export type IntentRoutingCounters = {
  readonly turnsSeen: number
  readonly turnsGatedOut: number
  readonly turnsSynthetic: number
  readonly recordsCreated: number
  readonly recordsEvicted: number
  readonly orphanObservations: number
  readonly unscorableResumeCalls: number
  readonly unscorableUnknownCalls: number
  readonly dispatchesDropped: number
  readonly malformedWriteRejections: number
  readonly recordsLostToCap: number
  readonly sinkTruncations: number
}

export type IntentRoutingCounterDelta = {
  readonly kind: "counter_delta"
  readonly schemaVersion: typeof INTENT_ROUTING_SCHEMA_VERSION
  readonly recordedAt: string
  readonly processId: string
  readonly counterEpoch: number
  readonly monotonicSeq: number
  readonly counters: IntentRoutingCounters
}

export type IntentRoutingEntry = IntentRoutingObservationRecord | IntentRoutingCounterDelta
