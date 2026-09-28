import type { DecisionUnavailableReason } from "./types"

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
])

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
  readonly tool: string
  readonly category: string | null
  readonly subagentType: string | null
  readonly requestedSubagentType: string | null
  readonly taskId: string | null
  readonly normalizedCategory: string
  readonly normalizedSubagent: string
  readonly routeClass: "category" | "subagent" | "unscorable_resume" | "unknown"
  readonly callID: string
}

export type IntentRoutingObservationRecord = {
  readonly kind: "observation"
  readonly schemaVersion: number
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
  readonly predictionStatus: "filled" | "failed" | "timeout" | "not_dispatched"
  readonly notDispatchedReason: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number
  readonly answers: IntentRoutingAnswers | null
  readonly invalidAnswerCount: number
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly observedAreAttempts: true
  readonly distinctCategoryCount: number
  readonly distinctSubagentCount: number
  readonly fanOutBucket: "zero" | "one" | "many"
  readonly correlationStatus: "reliable" | "censored" | "overlap_ambiguous"
  readonly sealedBy: "next_turn" | "session_idle" | "seal_timeout" | "dispose" | "session_deleted"
  readonly counterEpoch: number
}

export type IntentRoutingCounters = {
  readonly turnsSeen: number
  readonly turnsGatedOut: number
  readonly turnsSynthetic: number
  readonly recordsCreated: number
  readonly recordsInFlight: number
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
  readonly schemaVersion: number
  readonly recordedAt: string
  readonly processId: string
  readonly counterEpoch: number
  readonly monotonicSeq: number
  readonly counters: IntentRoutingCounters
}

export type IntentRoutingEntry = IntentRoutingObservationRecord | IntentRoutingCounterDelta

export function selectLatestCounterDeltasByProcess(
  entries: readonly IntentRoutingCounterDelta[],
): ReadonlyMap<string, IntentRoutingCounterDelta> {
  const latestByProcess = new Map<string, IntentRoutingCounterDelta>()
  for (const entry of entries) {
    const current = latestByProcess.get(entry.processId)
    if (
      current === undefined ||
      entry.counterEpoch > current.counterEpoch ||
      (entry.counterEpoch === current.counterEpoch && entry.monotonicSeq > current.monotonicSeq)
    ) {
      latestByProcess.set(entry.processId, entry)
    }
  }
  return latestByProcess
}

export {
  validateIntentRoutingCounterDelta,
  validateIntentRoutingEntry,
  validateIntentRoutingObservationRecord,
} from "./intent-routing-record-validation"
