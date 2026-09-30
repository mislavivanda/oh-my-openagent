import type {
  IntentRoutingAnswers,
  IntentRoutingCounters,
  IntentRoutingDecisionResult,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import type {
  IntentRoutingTurnSnapshot,
  MutableCounters,
  MutableTurn,
} from "./intent-routing-turn-types"

export const EMPTY_INTENT_ROUTING_ANSWERS: IntentRoutingAnswers = {
  intent: { choice: null, confidence: null, probabilities: null, valid: false },
  category: { choice: null, confidence: null, probabilities: null, valid: false },
  subagent: { choice: null, confidence: null, probabilities: null, valid: false },
  ambiguous: { noul: null, valid: false },
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function predictionAnswers(result: IntentRoutingDecisionResult): IntentRoutingAnswers {
  return {
    intent: {
      choice: result.answers.intent.choice,
      confidence: result.answers.intent.confidence,
      probabilities: result.answers.intent.probabilities,
      valid: result.answers.intent.valid,
    },
    category: {
      choice: result.answers.category.choice,
      confidence: result.answers.category.confidence,
      probabilities: result.answers.category.probabilities,
      valid: result.answers.category.valid,
    },
    subagent: {
      choice: result.answers.subagent.choice,
      confidence: result.answers.subagent.confidence,
      probabilities: result.answers.subagent.probabilities,
      valid: result.answers.subagent.valid,
    },
    ambiguous: result.answers.ambiguous,
  }
}

export function defaultCorrelationStatus(
  sealedBy: IntentRoutingObservationRecord["sealedBy"],
): IntentRoutingObservationRecord["correlationStatus"] {
  return sealedBy === "seal_timeout" || sealedBy === "dispose" ? "censored" : "reliable"
}

export function snapshotCounters(counters: MutableCounters): IntentRoutingCounters {
  return { ...counters }
}

export function createMutableCounters(): MutableCounters {
  return {
    turnsSeen: 0,
    turnsGatedOut: 0,
    turnsSynthetic: 0,
    recordsCreated: 0,
    recordsEvicted: 0,
    orphanObservations: 0,
    unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0,
    dispatchesDropped: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
}

function fanOutBucket(count: number): IntentRoutingObservationRecord["fanOutBucket"] {
  if (count === 0) return "zero"
  if (count === 1) return "one"
  return "many"
}

export function buildObservationRecord(
  turn: MutableTurn,
  now: () => number,
): IntentRoutingObservationRecord {
  const categories = new Set(
    turn.observed
      .filter((entry) => entry.routeClass === "category")
      .map((entry) => entry.normalizedCategory),
  )
  const subagents = new Set(
    turn.observed
      .filter((entry) => entry.routeClass === "subagent")
      .map((entry) => entry.normalizedSubagent),
  )
  const sealedBy = turn.sealedBy
  const correlationStatus = turn.correlationStatus
  if (sealedBy === null || correlationStatus === null || turn.predictionState === "pending") {
    throw new TypeError("Intent-routing record is not finalizable")
  }
  return {
    kind: "observation",
    schemaVersion: 1,
    questionVersion: turn.questionVersion,
    recordedAt: new Date(now()).toISOString(),
    sessionID: turn.sessionID,
    turnOrdinal: turn.turnOrdinal,
    dedupKey: turn.dedupKey,
    reuseKey: turn.reuseKey,
    predictionReused: turn.predictionReused,
    promptHeadChars: turn.promptHeadChars,
    promptFullSha256: turn.promptHash,
    promptChars: turn.promptChars,
    truncatedInput: turn.truncatedInput,
    isContinuationCandidate: turn.isContinuationCandidate,
    predictionStatus: turn.predictionState,
    notDispatchedReason: turn.notDispatchedReason,
    unavailableReason: turn.unavailableReason,
    resolvedModel: turn.resolvedModel,
    latencyMs: turn.latencyMs,
    answers: turn.answers,
    invalidAnswerCount: turn.invalidAnswerCount,
    observed: [...turn.observed],
    observedAreAttempts: true,
    distinctCategoryCount: categories.size,
    distinctSubagentCount: subagents.size,
    fanOutBucket: fanOutBucket(turn.observed.length),
    correlationStatus,
    sealedBy,
    counterEpoch: 0,
  }
}

export function snapshotTurn(turn: MutableTurn): IntentRoutingTurnSnapshot {
  return {
    sessionID: turn.sessionID,
    turnOrdinal: turn.turnOrdinal,
    dedupKey: turn.dedupKey,
    reuseKey: turn.reuseKey,
    promptHash: turn.promptHash,
    normalizedPrompt: turn.normalizedPrompt,
    predictionReused: turn.predictionReused,
    predictionState: turn.predictionState,
    lifecycleState: turn.lifecycleState,
    terminalState: turn.terminalState,
    resolvedModel: turn.resolvedModel,
    answers: turn.answers,
    observed: [...turn.observed],
    sealedBy: turn.sealedBy,
    correlationStatus: turn.correlationStatus,
    deferredFinalization: turn.deferredFinalization,
  }
}
