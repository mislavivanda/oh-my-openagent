// allow: SIZE_OK - deterministic corpus data keeps every report conditioning case reviewable in one place.
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  IntentRoutingAnswers,
  IntentRoutingChoiceAnswer,
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

const RECORDED_AT = "2026-09-24T12:00:00.000Z"

type PredictionStatus = IntentRoutingObservationRecord["predictionStatus"]
type CorrelationStatus = IntentRoutingObservationRecord["correlationStatus"]
type SealedBy = IntentRoutingObservationRecord["sealedBy"]

type RecordSpec = Readonly<{
  id: string
  ordinal?: number
  observed: readonly IntentRoutingObservedDelegation[]
  sealedBy: SealedBy
  predictionStatus?: PredictionStatus
  correlationStatus?: CorrelationStatus
  category?: string
  subagent?: string
  categoryValid?: boolean
  subagentValid?: boolean
  continuation?: boolean
  predictionReused?: boolean
  truncatedInput?: boolean
  invalidAnswerCount?: number
}>

const ZERO_COUNTERS: IntentRoutingCounters = {
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

function choice(choiceValue: string, valid = true): IntentRoutingChoiceAnswer {
  return { choice: choiceValue, confidence: 1, probabilities: { [choiceValue]: 1 }, valid }
}

function answers(spec: RecordSpec): IntentRoutingAnswers {
  return {
    intent: choice("implementation"),
    category: choice(spec.category ?? "none", spec.categoryValid ?? true),
    subagent: choice(spec.subagent ?? "none", spec.subagentValid ?? true),
    ambiguous: { noul: 0, valid: true },
  }
}

function category(name: string, callID: string): IntentRoutingObservedDelegation {
  return {
    tool: "task", category: name, subagentType: "sisyphus-junior", requestedSubagentType: null,
    taskId: null, normalizedCategory: name, normalizedSubagent: "none", routeClass: "category", callID,
  }
}

function subagent(name: string, callID: string): IntentRoutingObservedDelegation {
  return {
    tool: "call_omo_agent", category: null, subagentType: name, requestedSubagentType: null,
    taskId: null, normalizedCategory: "none", normalizedSubagent: name, routeClass: "subagent", callID,
  }
}

function resume(callID: string): IntentRoutingObservedDelegation {
  return {
    tool: "task", category: null, subagentType: null, requestedSubagentType: null,
    taskId: `task-${callID}`, normalizedCategory: "none", normalizedSubagent: "none",
    routeClass: "unscorable_resume", callID,
  }
}

function unknown(callID: string): IntentRoutingObservedDelegation {
  return {
    tool: "task", category: "legacy-category", subagentType: null, requestedSubagentType: null,
    taskId: null, normalizedCategory: "none", normalizedSubagent: "none", routeClass: "unknown", callID,
  }
}

const UNAVAILABLE_BY_STATUS = {
  filled: null,
  failed: "transport_error",
  timeout: "timeout",
  not_dispatched: null,
} as const satisfies Readonly<Record<PredictionStatus, IntentRoutingObservationRecord["unavailableReason"]>>

function observation(spec: RecordSpec): IntentRoutingObservationRecord {
  const predictionStatus = spec.predictionStatus ?? "filled"
  const categoryTargets = new Set(spec.observed.filter((item) => item.routeClass === "category").map((item) => item.normalizedCategory))
  const subagentTargets = new Set(spec.observed.filter((item) => item.routeClass === "subagent").map((item) => item.normalizedSubagent))
  return {
    kind: "observation", schemaVersion: 1, questionVersion: 1, recordedAt: RECORDED_AT,
    sessionID: `fixture-${spec.id}`, turnOrdinal: spec.ordinal ?? 1, dedupKey: `dedup-${spec.id}`,
    reuseKey: `reuse-${spec.id}`, predictionReused: spec.predictionReused ?? false,
    promptHeadChars: spec.id, promptFullSha256: createHash("sha256").update(spec.id).digest("hex"),
    promptChars: spec.id.length, truncatedInput: spec.truncatedInput ?? false,
    isContinuationCandidate: spec.continuation ?? false, predictionStatus,
    notDispatchedReason: predictionStatus === "not_dispatched" ? "max_inflight" : null,
    unavailableReason: UNAVAILABLE_BY_STATUS[predictionStatus], resolvedModel: predictionStatus === "filled" ? "jev-1.13.0" : null,
    latencyMs: 10, answers: predictionStatus === "filled" ? answers(spec) : null,
    invalidAnswerCount: spec.invalidAnswerCount ?? 0, observed: spec.observed, observedAreAttempts: true,
    distinctCategoryCount: categoryTargets.size, distinctSubagentCount: subagentTargets.size,
    fanOutBucket: spec.observed.length === 0 ? "zero" : spec.observed.length === 1 ? "one" : "many",
    correlationStatus: spec.correlationStatus ?? "reliable", sealedBy: spec.sealedBy, counterEpoch: 1,
  }
}

const RECORD_SPECS: readonly RecordSpec[] = [
  { id: "zero-none", observed: [], category: "none", sealedBy: "next_turn", continuation: true },
  { id: "category-missed-as-none", observed: [category("deep", "c2")], category: "none", sealedBy: "session_idle" },
  { id: "category-hit", observed: [category("deep", "c3")], category: "deep", sealedBy: "session_deleted" },
  { id: "unknown-only", observed: [unknown("u4")], category: "none", sealedBy: "dispose" },
  { id: "resume-only", observed: [resume("r5")], category: "none", sealedBy: "next_turn" },
  { id: "mixed-resume-category", observed: [resume("r6"), category("quick", "c6")], category: "quick", sealedBy: "session_idle" },
  { id: "many-categories", observed: [category("deep", "c7a"), category("quick", "c7b"), category("writing", "c7c"), unknown("u7")], category: "deep", sealedBy: "session_deleted", truncatedInput: true },
  { id: "duplicate-category", observed: [category("deep", "c8a"), category("deep", "c8b")], category: "deep", sealedBy: "next_turn", predictionReused: true },
  { id: "invalid-category", observed: [category("deep", "c9")], category: "deep", categoryValid: false, invalidAnswerCount: 1, sealedBy: "next_turn" },
  { id: "incoherent", observed: [category("deep", "c10")], category: "deep", subagent: "explore", sealedBy: "next_turn" },
  { id: "failed", observed: [category("deep", "c11")], predictionStatus: "failed", sealedBy: "session_idle" },
  { id: "timeout", observed: [], predictionStatus: "timeout", sealedBy: "seal_timeout" },
  { id: "not-dispatched", observed: [category("quick", "c13")], predictionStatus: "not_dispatched", sealedBy: "dispose" },
  { id: "subagent-hit", observed: [subagent("explore", "s14")], subagent: "explore", sealedBy: "session_deleted" },
  { id: "many-subagents", observed: [subagent("explore", "s15a"), subagent("oracle", "s15b"), subagent("librarian", "s15c")], subagent: "explore", sealedBy: "next_turn" },
  { id: "censored-empty", observed: [], category: "none", correlationStatus: "censored", sealedBy: "seal_timeout" },
  { id: "overlap", observed: [category("deep", "c17"), unknown("u17")], category: "deep", correlationStatus: "overlap_ambiguous", sealedBy: "next_turn" },
]

function counterDelta(input: Readonly<{
  processId: string
  counterEpoch: number
  monotonicSeq: number
  counters: IntentRoutingCounters
}>): IntentRoutingCounterDelta {
  return { kind: "counter_delta", schemaVersion: 1, recordedAt: RECORDED_AT, ...input }
}

const PROCESS_A_COUNTERS: IntentRoutingCounters = {
  ...ZERO_COUNTERS, turnsSeen: 20, turnsGatedOut: 2, turnsSynthetic: 1, recordsCreated: 18,
  recordsEvicted: 1, orphanObservations: 2, unscorableResumeCalls: 2, unscorableUnknownCalls: 2,
  dispatchesDropped: 3, malformedWriteRejections: 1, recordsLostToCap: 2, sinkTruncations: 1,
}
const PROCESS_B_COUNTERS: IntentRoutingCounters = {
  ...ZERO_COUNTERS, turnsSeen: 5, turnsGatedOut: 1, turnsSynthetic: 2, recordsCreated: 4,
  recordsEvicted: 1, orphanObservations: 1, unscorableResumeCalls: 1, unscorableUnknownCalls: 1,
  dispatchesDropped: 1, malformedWriteRejections: 2, recordsLostToCap: 1, sinkTruncations: 2,
}

export function writeSyntheticCorpus(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const records = RECORD_SPECS.map((spec, index) => observation({ ...spec, ordinal: index + 1 }))
  const processAEntries = [
    ...records.slice(0, 9),
    counterDelta({ processId: "process-a", counterEpoch: 0, monotonicSeq: 99, counters: { ...PROCESS_A_COUNTERS, turnsSeen: 1_000, recordsCreated: 1_000 } }),
    counterDelta({ processId: "process-a", counterEpoch: 1, monotonicSeq: 1, counters: { ...PROCESS_A_COUNTERS, turnsSeen: 19 } }),
    counterDelta({ processId: "process-a", counterEpoch: 1, monotonicSeq: 2, counters: PROCESS_A_COUNTERS }),
  ]
  const processBEntries = [
    ...records.slice(9),
    counterDelta({ processId: "process-b", counterEpoch: 4, monotonicSeq: 7, counters: PROCESS_B_COUNTERS }),
  ]
  writeFileSync(join(directory, "w1-20260924-process-a.jsonl"), `${processAEntries.map((entry) => JSON.stringify(entry)).join("\n")}\nnot-json\n{}\n`, { mode: 0o600 })
  writeFileSync(join(directory, "w1-20260924-process-b.jsonl"), `${processBEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 })
}
