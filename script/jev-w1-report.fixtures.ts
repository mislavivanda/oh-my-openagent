import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  INTENT_ROUTING_SCHEMA_VERSION,
  type IntentRoutingAnswers,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingObservedDelegation,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

type RouteSpec =
  | { readonly kind: "category"; readonly target: string }
  | { readonly kind: "subagent"; readonly target: string }
  | { readonly kind: "resume" }
  | { readonly kind: "unknown" }

type RecordSpec = {
  readonly routes?: readonly RouteSpec[]
  readonly category?: string
  readonly subagent?: string
  readonly invalidCategory?: boolean
  readonly status?: IntentRoutingObservationRecord["predictionStatus"]
  readonly correlation?: IntentRoutingObservationRecord["correlationStatus"]
  readonly sealedBy: IntentRoutingObservationRecord["sealedBy"]
  readonly continuation?: string
}

const FIXED_TIME = "2026-09-24T00:00:00.000Z"

function choice(choice: string, valid = true): IntentRoutingAnswers["category"] {
  return { choice, confidence: 1, probabilities: valid ? { [choice]: 1 } : {}, valid }
}

function answers(spec: RecordSpec): IntentRoutingAnswers {
  return {
    intent: choice("delegate"),
    category: choice(spec.category ?? "none", !(spec.invalidCategory ?? false)),
    subagent: choice(spec.subagent ?? "none"),
    ambiguous: { noul: 0, valid: true },
  }
}

function observed(spec: RouteSpec, ordinal: number, index: number): IntentRoutingObservedDelegation {
  const common = {
    tool: "task" as const,
    requestedSubagentType: null,
    callID: `call-${ordinal}-${index}`,
  }
  switch (spec.kind) {
    case "category":
      return {
        ...common,
        category: spec.target,
        subagentType: "sisyphus-junior",
        taskId: null,
        normalizedCategory: spec.target,
        normalizedSubagent: "none",
        routeClass: "category",
      }
    case "subagent":
      return {
        ...common,
        category: null,
        subagentType: spec.target,
        taskId: null,
        normalizedCategory: "none",
        normalizedSubagent: spec.target,
        routeClass: "subagent",
      }
    case "resume":
      return {
        ...common,
        category: null,
        subagentType: null,
        taskId: `task-${ordinal}`,
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unscorable_resume",
      }
    case "unknown":
      return {
        ...common,
        category: "legacy-route",
        subagentType: null,
        taskId: null,
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unknown",
      }
  }
}

function record(spec: RecordSpec, index: number): IntentRoutingObservationRecord {
  const ordinal = index + 1
  const routes = spec.routes ?? []
  const observations = routes.map((route, routeIndex) => observed(route, ordinal, routeIndex))
  const categories = new Set(observations.filter((item) => item.routeClass === "category").map((item) => item.normalizedCategory))
  const subagents = new Set(observations.filter((item) => item.routeClass === "subagent").map((item) => item.normalizedSubagent))
  const status = spec.status ?? "filled"
  const prompt = spec.continuation ?? `synthetic turn ${ordinal}`
  return {
    kind: "observation",
    schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
    questionVersion: 1,
    recordedAt: FIXED_TIME,
    sessionID: "synthetic-session",
    turnOrdinal: ordinal,
    dedupKey: ordinal.toString(16).padStart(64, "0"),
    reuseKey: `reuse-${ordinal}`,
    predictionReused: ordinal === 5 || ordinal === 30,
    promptHeadChars: prompt,
    promptFullSha256: (ordinal === 30 ? 5 : ordinal).toString(16).padStart(64, "0"),
    promptChars: prompt.length,
    truncatedInput: ordinal === 20,
    isContinuationCandidate: spec.continuation !== undefined,
    predictionStatus: status,
    notDispatchedReason: status === "not_dispatched" ? "max_inflight" : null,
    unavailableReason: status === "failed" ? "transport_error" : status === "timeout" ? "timeout" : null,
    resolvedModel: status === "filled" ? "jev-1.13.0" : null,
    latencyMs: status === "filled" ? 50 : null,
    answers: status === "filled" ? answers(spec) : null,
    invalidAnswerCount: spec.invalidCategory === true ? 1 : 0,
    observed: observations,
    observedAreAttempts: true,
    distinctCategoryCount: categories.size,
    distinctSubagentCount: subagents.size,
    fanOutBucket: observations.length === 0 ? "zero" : observations.length === 1 ? "one" : "many",
    correlationStatus: spec.correlation ?? "reliable",
    sealedBy: spec.sealedBy,
    counterEpoch: 1,
  }
}

const RECORD_SPECS: readonly RecordSpec[] = [
  { sealedBy: "next_turn" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", sealedBy: "session_idle" },
  { routes: [{ kind: "subagent", target: "oracle" }], subagent: "oracle", sealedBy: "seal_timeout" },
  { routes: [{ kind: "category", target: "quick" }, { kind: "subagent", target: "oracle" }], category: "quick", sealedBy: "dispose" },
  { routes: [{ kind: "category", target: "quick" }, { kind: "category", target: "quick" }], category: "quick", sealedBy: "session_deleted" },
  { routes: [{ kind: "resume" }], sealedBy: "session_idle" },
  { routes: [{ kind: "unknown" }], sealedBy: "session_idle" },
  { routes: [{ kind: "resume" }, { kind: "category", target: "quick" }], category: "quick", sealedBy: "session_idle" },
  { routes: [{ kind: "category", target: "quick" }], status: "failed", sealedBy: "next_turn" },
  { status: "timeout", sealedBy: "seal_timeout" },
  { routes: [{ kind: "subagent", target: "oracle" }], status: "not_dispatched", sealedBy: "dispose" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", invalidCategory: true, sealedBy: "session_deleted" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", subagent: "oracle", sealedBy: "next_turn" },
  { correlation: "censored", sealedBy: "session_idle" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", correlation: "overlap_ambiguous", sealedBy: "seal_timeout" },
  { routes: [{ kind: "subagent", target: "oracle" }], subagent: "oracle", correlation: "overlap_ambiguous", sealedBy: "dispose" },
  { category: "quick", sealedBy: "next_turn" },
  { routes: [{ kind: "category", target: "quick" }], sealedBy: "session_idle" },
  { sealedBy: "seal_timeout" },
  { routes: [{ kind: "category", target: "quick" }, { kind: "category", target: "deep" }, { kind: "category", target: "explore" }], category: "deep", sealedBy: "next_turn" },
  { routes: [{ kind: "category", target: "quick" }, { kind: "category", target: "deep" }], category: "quick", sealedBy: "dispose" },
  { routes: [{ kind: "category", target: "deep" }], category: "quick", sealedBy: "seal_timeout" },
  { routes: [{ kind: "subagent", target: "oracle" }], sealedBy: "dispose" },
  { routes: [{ kind: "subagent", target: "oracle" }], subagent: "oracle", continuation: "continue", sealedBy: "session_idle" },
  { continuation: "go on", sealedBy: "seal_timeout" },
  { routes: [{ kind: "subagent", target: "oracle" }, { kind: "subagent", target: "explore" }], subagent: "explore", sealedBy: "dispose" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", sealedBy: "next_turn" },
  { routes: [{ kind: "subagent", target: "oracle" }], subagent: "oracle", sealedBy: "session_deleted" },
  { sealedBy: "session_idle" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", sealedBy: "seal_timeout" },
  { routes: [{ kind: "category", target: "quick" }], category: "quick", correlation: "censored", sealedBy: "dispose" },
  { correlation: "overlap_ambiguous", sealedBy: "session_deleted" },
]

function counters(values: Partial<IntentRoutingCounters>): IntentRoutingCounters {
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
    ...values,
  }
}

function counter(processId: string, counterEpoch: number, monotonicSeq: number, values: Partial<IntentRoutingCounters>): IntentRoutingCounterDelta {
  return { kind: "counter_delta", schemaVersion: INTENT_ROUTING_SCHEMA_VERSION, recordedAt: FIXED_TIME, processId, counterEpoch, monotonicSeq, counters: counters(values) }
}

export function writeSyntheticCorpus(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const records = RECORD_SPECS.map(record)
  const processA = "101-1727136000000000000-aaaaaaaaaaaa"
  const processB = "202-1727136000000000000-bbbbbbbbbbbb"
  const firstFile = [
    counter(processA, 0, 9, counters({ turnsSeen: 100, recordsCreated: 100 })),
    counter(processA, 1, 1, counters({ turnsSeen: 29, recordsCreated: 24 })),
    ...records.slice(0, 22),
    counter(processA, 1, 2, counters({ turnsSeen: 30, turnsGatedOut: 3, turnsSynthetic: 2, recordsCreated: 25, recordsEvicted: 1, orphanObservations: 1, unscorableResumeCalls: 1, unscorableUnknownCalls: 1, dispatchesDropped: 1, malformedWriteRejections: 1, recordsLostToCap: 5, sinkTruncations: 1 })),
  ]
  const secondFile = [
    ...records.slice(22),
    counter(processB, 0, 4, counters({ turnsSeen: 10, turnsGatedOut: 1, turnsSynthetic: 1, recordsCreated: 10, orphanObservations: 1, unscorableResumeCalls: 1, dispatchesDropped: 1 })),
  ]
  writeFileSync(join(dir, `w1-20260924-${processA}.jsonl`), `${firstFile.map((entry) => JSON.stringify(entry)).join("\n")}\nnot-json\n`)
  writeFileSync(join(dir, `w1-20260924-${processB}.jsonl`), `${secondFile.map((entry) => JSON.stringify(entry)).join("\n")}\n{"kind":"unexpected"}\n`)
}
