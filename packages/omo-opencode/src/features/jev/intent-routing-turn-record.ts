import { createHash } from "node:crypto"
import {
  INTENT_ROUTING_CONTINUATION_LEXICON,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import { isRealUserTextPart } from "../../shared"
import { removeSystemReminders } from "../../shared/system-directive"
import type {
  IntentRoutingTextPart,
  IntentRoutingTurnInput,
  IntentRoutingTurnSnapshot,
  LiveIntentRoutingTurn,
} from "./intent-routing-turn-store-types"

const PINNED_JEV_MODEL = /^jev-(?:\d+\.\d+\.\d+|\d{4}-\d{2}-\d{2})(?:[-+][0-9A-Za-z.-]+)?$/
const PROMPT_HEAD_CHARS = 200

export function normalizeIntentRoutingPrompt(parts: readonly IntentRoutingTextPart[]): string {
  return removeSystemReminders(parts.filter(isRealUserTextPart).map((part) => part.text).join("\n"))
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
}

export function createTurnIdentity(input: IntentRoutingTurnInput): Readonly<{
  prompt: string
  promptHash: string
  dedupKey: string
}> {
  const prompt = normalizeIntentRoutingPrompt(input.parts)
  const promptHash = createHash("sha256").update(prompt).digest("hex")
  const dedupKey = JSON.stringify([
    input.sessionID,
    promptHash,
    input.questionVersion,
    input.vocabularyDigest,
    input.confidenceThreshold,
    input.configuredModelSpec,
  ])
  return { prompt, promptHash, dedupKey }
}

export function completedReuseKey(dedupKey: string, resolvedModel: string): string {
  return JSON.stringify([dedupKey, resolvedModel])
}

export function completedLookupModel(input: IntentRoutingTurnInput): string | undefined {
  return PINNED_JEV_MODEL.test(input.configuredModelSpec)
    ? input.configuredModelSpec
    : input.currentResolvedModel
}

export function snapshotTurn(turn: LiveIntentRoutingTurn): IntentRoutingTurnSnapshot {
  return Object.freeze({
    state: turn.state,
    sessionID: turn.sessionID,
    turnOrdinal: turn.turnOrdinal,
    dedupKey: turn.dedupKey,
    reuseKey: turn.reuseKey,
    predictionStatus: turn.predictionStatus,
    predictionReused: turn.predictionReused,
    resolvedModel: turn.resolvedModel,
    answers: turn.answers,
    observed: Object.freeze([...turn.observed]),
    sealedBy: turn.sealedBy,
    correlationStatus: turn.correlationStatus,
    correlationWindowClosed: turn.correlationWindowClosed,
    finalized: turn.finalized,
  })
}

export function buildObservationRecord(
  turn: LiveIntentRoutingTurn,
  context: Readonly<{ schemaVersion: number; counterEpoch: number; recordedAt: string }>,
): IntentRoutingObservationRecord {
  if (turn.predictionStatus === "pending" || turn.sealedBy === null || turn.correlationStatus === null) {
    throw new Error("Intent-routing turn is not finalizable")
  }
  const categoryTargets = new Set(turn.observed.map((item) => item.normalizedCategory).filter(isScorableTarget))
  const subagentTargets = new Set(turn.observed.map((item) => item.normalizedSubagent).filter(isScorableTarget))
  return {
    kind: "observation",
    schemaVersion: context.schemaVersion,
    questionVersion: turn.questionVersion,
    recordedAt: context.recordedAt,
    sessionID: turn.sessionID,
    turnOrdinal: turn.turnOrdinal,
    dedupKey: turn.dedupKey,
    reuseKey: turn.reuseKey,
    predictionReused: turn.predictionReused,
    promptHeadChars: turn.prompt.slice(0, PROMPT_HEAD_CHARS),
    promptFullSha256: turn.promptHash,
    promptChars: turn.prompt.length,
    truncatedInput: turn.truncatedInput,
    isContinuationCandidate: INTENT_ROUTING_CONTINUATION_LEXICON.includes(turn.prompt),
    predictionStatus: turn.predictionStatus,
    notDispatchedReason: turn.notDispatchedReason,
    unavailableReason: turn.unavailableReason,
    resolvedModel: turn.resolvedModel,
    latencyMs: turn.latencyMs,
    answers: turn.answers,
    invalidAnswerCount: turn.invalidAnswerCount,
    observed: [...turn.observed],
    observedAreAttempts: true,
    distinctCategoryCount: categoryTargets.size,
    distinctSubagentCount: subagentTargets.size,
    fanOutBucket: turn.observed.length === 0 ? "zero" : turn.observed.length === 1 ? "one" : "many",
    correlationStatus: turn.correlationStatus,
    sealedBy: turn.sealedBy,
    counterEpoch: context.counterEpoch,
  }
}

function isScorableTarget(value: string): boolean {
  return value !== "none" && value !== "unknown"
}

export function buildStoreCounterDelta(input: Readonly<{
  schemaVersion: number
  recordedAt: string
  processId: string
  counterEpoch: number
  monotonicSeq: number
  recordsCreated: number
  recordsEvicted: number
  orphanObservations: number
}>): IntentRoutingCounterDelta {
  const counters: IntentRoutingCounters = {
    turnsSeen: 0,
    turnsGatedOut: 0,
    turnsSynthetic: 0,
    recordsCreated: input.recordsCreated,
    recordsEvicted: input.recordsEvicted,
    orphanObservations: input.orphanObservations,
    unscorableResumeCalls: 0,
    unscorableUnknownCalls: 0,
    dispatchesDropped: 0,
    malformedWriteRejections: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
  }
  return {
    kind: "counter_delta",
    schemaVersion: input.schemaVersion,
    recordedAt: input.recordedAt,
    processId: input.processId,
    counterEpoch: input.counterEpoch,
    monotonicSeq: input.monotonicSeq,
    counters,
  }
}
