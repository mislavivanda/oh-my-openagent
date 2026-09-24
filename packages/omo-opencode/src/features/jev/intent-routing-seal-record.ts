import {
  INTENT_ROUTING_PROMPT_HEAD_MAX_CHARS,
  INTENT_ROUTING_SCHEMA_VERSION,
  isIntentRoutingContinuationCandidate,
  type IntentRoutingAnswers,
  type IntentRoutingChoiceAnswer,
  type IntentRoutingFanOutBucket,
  type IntentRoutingNoulAnswer,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

import type { IntentRoutingTurnRecord } from "./intent-routing-turn-store"

export type IntentRoutingSealTurnMetadata = {
  readonly questionVersion: number
  readonly normalizedPrompt: string
}

function isProbabilityRecord(value: unknown): value is Readonly<Record<string, number>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((probability) => typeof probability === "number" && Number.isFinite(probability))
}

function recordChoiceAnswer(value: {
  readonly choice: unknown
  readonly confidence: unknown
  readonly probabilities: unknown
  readonly valid: boolean
}): IntentRoutingChoiceAnswer | null {
  if (
    typeof value.choice !== "string" || typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) || !isProbabilityRecord(value.probabilities)
  ) return null
  return {
    choice: value.choice,
    confidence: value.confidence,
    probabilities: value.probabilities,
    valid: value.valid,
  }
}

function recordNoulAnswer(value: {
  readonly noul: unknown
  readonly valid: boolean
}): IntentRoutingNoulAnswer | null {
  return typeof value.noul === "number" && Number.isFinite(value.noul)
    ? { noul: value.noul, valid: value.valid }
    : null
}

function recordAnswers(turn: IntentRoutingTurnRecord): IntentRoutingAnswers | null {
  if (turn.answers === null) return null
  const intent = recordChoiceAnswer(turn.answers.intent)
  const category = recordChoiceAnswer(turn.answers.category)
  const subagent = recordChoiceAnswer(turn.answers.subagent)
  const ambiguous = recordNoulAnswer(turn.answers.ambiguous)
  return intent && category && subagent && ambiguous ? { intent, category, subagent, ambiguous } : null
}

function fanOutBucket(count: number): IntentRoutingFanOutBucket {
  if (count === 0) return "zero"
  return count === 1 ? "one" : "many"
}

export function materializeIntentRoutingObservation(args: {
  readonly turn: IntentRoutingTurnRecord
  readonly metadata: IntentRoutingSealTurnMetadata
  readonly recordedAt: string
  readonly counterEpoch: number
}): IntentRoutingObservationRecord | null {
  const { turn, metadata } = args
  if (
    turn.sealedBy === null || turn.correlationStatus === null ||
    turn.predictionStatus === "pending"
  ) return null
  const categories = new Set(turn.observed.filter(({ routeClass }) => routeClass === "category")
    .map(({ normalizedCategory }) => normalizedCategory))
  const subagents = new Set(turn.observed.filter(({ routeClass }) => routeClass === "subagent")
    .map(({ normalizedSubagent }) => normalizedSubagent))
  return {
    kind: "observation",
    schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
    questionVersion: metadata.questionVersion,
    recordedAt: args.recordedAt,
    sessionID: turn.sessionID,
    turnOrdinal: turn.turnOrdinal,
    dedupKey: turn.dedupKey,
    reuseKey: turn.reuseKey,
    predictionReused: turn.predictionReused,
    promptHeadChars: metadata.normalizedPrompt.slice(0, INTENT_ROUTING_PROMPT_HEAD_MAX_CHARS),
    promptFullSha256: turn.dedupKey,
    promptChars: metadata.normalizedPrompt.length,
    truncatedInput: turn.truncatedInput,
    isContinuationCandidate: isIntentRoutingContinuationCandidate(metadata.normalizedPrompt),
    predictionStatus: turn.predictionStatus,
    notDispatchedReason: turn.notDispatchedReason,
    unavailableReason: turn.unavailableReason,
    resolvedModel: turn.resolvedModel,
    latencyMs: turn.latencyMs,
    answers: recordAnswers(turn),
    invalidAnswerCount: turn.invalidAnswerCount,
    observed: turn.observed,
    observedAreAttempts: true,
    distinctCategoryCount: categories.size,
    distinctSubagentCount: subagents.size,
    fanOutBucket: fanOutBucket(turn.observed.length),
    correlationStatus: turn.correlationStatus,
    sealedBy: turn.sealedBy,
    counterEpoch: args.counterEpoch,
  }
}
