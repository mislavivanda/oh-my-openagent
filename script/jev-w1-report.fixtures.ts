import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "../packages/jev-core/src"

type PredictionStatus = IntentRoutingObservationRecord["predictionStatus"]
type CorrelationStatus = IntentRoutingObservationRecord["correlationStatus"]
type SealedBy = IntentRoutingObservationRecord["sealedBy"]

type ObservationArgs = {
  readonly id: number
  readonly observed: readonly IntentRoutingObservedDelegation[]
  readonly categoryChoice: string
  readonly subagentChoice: string
  readonly sealedBy: SealedBy
  readonly predictionStatus?: PredictionStatus
  readonly correlationStatus?: CorrelationStatus
  readonly categoryValid?: boolean
  readonly subagentValid?: boolean
  readonly invalidAnswerCount?: number
  readonly continuation?: boolean
  readonly predictionReused?: boolean
  readonly truncatedInput?: boolean
}

const RECORDED_AT = "2026-09-24T00:00:00.000Z"

function observed(
  routeClass: IntentRoutingObservedDelegation["routeClass"],
  target = "none",
): IntentRoutingObservedDelegation {
  return {
    tool: "call_omo_agent",
    category: routeClass === "category" ? target : null,
    subagentType: routeClass === "subagent" ? target : null,
    requestedSubagentType: null,
    taskId: routeClass === "unscorable_resume" ? "task-resume" : null,
    normalizedCategory: routeClass === "category" ? target : "none",
    normalizedSubagent: routeClass === "subagent" ? target : "none",
    routeClass,
    callID: `call-${routeClass}-${target}`,
  }
}

function fanOut(observations: readonly IntentRoutingObservedDelegation[]): "zero" | "one" | "many" {
  const routes = new Set(observations.flatMap((item) => {
    if (item.routeClass === "category") return [`category:${item.normalizedCategory}`]
    if (item.routeClass === "subagent") return [`subagent:${item.normalizedSubagent}`]
    return []
  }))
  if (routes.size === 0) return "zero"
  return routes.size === 1 ? "one" : "many"
}

function observation(args: ObservationArgs): IntentRoutingObservationRecord {
  const predictionStatus = args.predictionStatus ?? "filled"
  const categories = new Set(args.observed.filter((item) => item.routeClass === "category").map((item) => item.normalizedCategory))
  const subagents = new Set(args.observed.filter((item) => item.routeClass === "subagent").map((item) => item.normalizedSubagent))
  return {
    kind: "observation",
    schemaVersion: 1,
    questionVersion: 1,
    recordedAt: RECORDED_AT,
    sessionID: `session-${args.id}`,
    turnOrdinal: args.id,
    dedupKey: `dedup-${args.id}`,
    reuseKey: `reuse-${args.id}`,
    predictionReused: args.predictionReused ?? false,
    promptHeadChars: `synthetic prompt ${args.id}`,
    promptFullSha256: args.id.toString(16).padStart(64, "0"),
    promptChars: args.truncatedInput === true ? 400 : 20,
    truncatedInput: args.truncatedInput ?? false,
    isContinuationCandidate: args.continuation ?? false,
    predictionStatus,
    notDispatchedReason: predictionStatus === "not_dispatched" ? "disabled" : null,
    unavailableReason: predictionStatus === "failed" ? "transport_error" : predictionStatus === "timeout" ? "timeout" : null,
    resolvedModel: predictionStatus === "filled" ? "synthetic-model" : null,
    latencyMs: 1,
    answers: {
      intent: { choice: "delegate", confidence: 1, probabilities: null, valid: true },
      category: { choice: args.categoryChoice, confidence: 1, probabilities: null, valid: args.categoryValid ?? true },
      subagent: { choice: args.subagentChoice, confidence: 1, probabilities: null, valid: args.subagentValid ?? true },
      ambiguous: { noul: 0, valid: true },
    },
    invalidAnswerCount: args.invalidAnswerCount ?? 0,
    observed: args.observed,
    observedAreAttempts: true,
    distinctCategoryCount: categories.size,
    distinctSubagentCount: subagents.size,
    fanOutBucket: fanOut(args.observed),
    correlationStatus: args.correlationStatus ?? "reliable",
    sealedBy: args.sealedBy,
    counterEpoch: 1,
  }
}

function counters(overrides: Partial<IntentRoutingCounters>): IntentRoutingCounters {
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
    ...overrides,
  }
}

function delta(processId: string, counterEpoch: number, monotonicSeq: number, values: IntentRoutingCounters): IntentRoutingCounterDelta {
  return { kind: "counter_delta", schemaVersion: 1, recordedAt: RECORDED_AT, processId, counterEpoch, monotonicSeq, counters: values }
}

function jsonLines(entries: readonly object[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
}

export function writeSyntheticCorpus(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const c = observed("category", "deep")
  const q = observed("category", "quick")
  const e = observed("subagent", "explore")
  const resume = observed("unscorable_resume")
  const unknown = observed("unknown")
  const records = [
    observation({ id: 1, observed: [], categoryChoice: "none", subagentChoice: "none", sealedBy: "next_turn" }),
    observation({ id: 2, observed: [c], categoryChoice: "none", subagentChoice: "none", sealedBy: "session_idle", truncatedInput: true }),
    observation({ id: 3, observed: [e], categoryChoice: "none", subagentChoice: "explore", sealedBy: "seal_timeout" }),
    observation({ id: 4, observed: [c, q, c], categoryChoice: "deep", subagentChoice: "none", sealedBy: "dispose" }),
    observation({ id: 5, observed: [resume], categoryChoice: "none", subagentChoice: "none", sealedBy: "session_deleted", continuation: true }),
    observation({ id: 6, observed: [unknown], categoryChoice: "none", subagentChoice: "none", sealedBy: "next_turn" }),
    observation({ id: 7, observed: [], categoryChoice: "none", subagentChoice: "none", sealedBy: "session_idle", predictionStatus: "failed" }),
    observation({ id: 8, observed: [e], categoryChoice: "none", subagentChoice: "explore", sealedBy: "seal_timeout", predictionStatus: "timeout" }),
    observation({ id: 9, observed: [q], categoryChoice: "quick", subagentChoice: "none", sealedBy: "dispose", predictionStatus: "not_dispatched" }),
    observation({ id: 10, observed: [], categoryChoice: "none", subagentChoice: "none", sealedBy: "session_deleted", correlationStatus: "censored" }),
    observation({ id: 11, observed: [], categoryChoice: "none", subagentChoice: "none", sealedBy: "next_turn", correlationStatus: "overlap_ambiguous" }),
    observation({ id: 12, observed: [resume, q], categoryChoice: "quick", subagentChoice: "none", sealedBy: "session_idle", continuation: true, predictionReused: true }),
    observation({ id: 13, observed: [q], categoryChoice: "quick", subagentChoice: "none", sealedBy: "seal_timeout", categoryValid: false, invalidAnswerCount: 1 }),
    observation({ id: 14, observed: [q], categoryChoice: "quick", subagentChoice: "explore", sealedBy: "dispose" }),
    observation({ id: 15, observed: [q], categoryChoice: "none", subagentChoice: "none", sealedBy: "session_deleted" }),
    observation({ id: 16, observed: [], categoryChoice: "deep", subagentChoice: "none", sealedBy: "next_turn" }),
    observation({ id: 17, observed: [observed("subagent", "oracle"), observed("subagent", "librarian"), e, e], categoryChoice: "none", subagentChoice: "oracle", sealedBy: "session_idle" }),
  ]
  const p1 = counters({ turnsSeen: 18, turnsGatedOut: 2, turnsSynthetic: 1, recordsCreated: 18, recordsEvicted: 1, orphanObservations: 2, unscorableResumeCalls: 2, unscorableUnknownCalls: 1, dispatchesDropped: 3, malformedWriteRejections: 4, recordsLostToCap: 5, sinkTruncations: 1 })
  const p2 = counters({ turnsSeen: 2, turnsGatedOut: 1, recordsCreated: 2, recordsEvicted: 1, orphanObservations: 1, dispatchesDropped: 1, malformedWriteRejections: 1, recordsLostToCap: 2, sinkTruncations: 1 })
  writeFileSync(join(dir, "w1-p1.jsonl"), jsonLines([
    ...records.slice(0, 12),
    delta("p1", 0, 99, counters({ turnsSeen: 900, recordsCreated: 900, sinkTruncations: 20 })),
    delta("p1", 1, 1, counters({ turnsSeen: 17 })),
    delta("p1", 1, 2, p1),
  ]))
  writeFileSync(join(dir, "w1-p2.jsonl"), jsonLines([...records.slice(12), delta("p2", 0, 1, counters({ turnsSeen: 1 })), delta("p2", 0, 2, p2)]))
  writeFileSync(join(dir, "w1-malformed.jsonl"), "{partial\n")
}
