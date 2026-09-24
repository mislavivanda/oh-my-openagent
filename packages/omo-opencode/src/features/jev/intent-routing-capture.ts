import {
  normalizeObservedDelegation,
  type IntentRoutingCounters,
  type IntentRoutingObservationRecord,
  type IntentRoutingObservedDelegation,
  type IntentRoutingRouteClass,
  type IntentRoutingVocabularyEntry,
} from "@oh-my-opencode/jev-core"
import { isJevIntentRoutingSessionEligible } from "./intent-routing-session-gate"

export const INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST = Object.freeze([
  "task",
  "call_omo_agent",
] as const)

type IntentRoutingDelegationTool =
  (typeof INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST)[number]
const delegationTools = new Set<string>(INTENT_ROUTING_DELEGATION_TOOL_ALLOWLIST)

export type IntentRoutingCaptureRecord = Pick<
  IntentRoutingObservationRecord,
  "observed" | "observedAreAttempts" | "distinctCategoryCount" | "distinctSubagentCount"
>

export type IntentRoutingCaptureCounters = Pick<
  IntentRoutingCounters,
  "orphanObservations" | "unscorableResumeCalls" | "unscorableUnknownCalls"
>

export type IntentRoutingCaptureResult = {
  readonly captured: boolean
  readonly record: IntentRoutingCaptureRecord | null
  readonly counters: IntentRoutingCaptureCounters
}

export type IntentRoutingCaptureArgs = {
  readonly input: {
    readonly tool: string
    readonly sessionID: string
    readonly callID: string
  }
  readonly output: { readonly args: Record<string, unknown> }
  readonly mainSessionID: string | undefined
  readonly isSubagentSession: boolean
  readonly offeredCategories: readonly IntentRoutingVocabularyEntry[]
  readonly record: IntentRoutingCaptureRecord | null
  readonly counters: IntentRoutingCaptureCounters
}

export type IntentRoutingDelegationAttemptArgs = Pick<
  IntentRoutingCaptureArgs,
  "input" | "output" | "mainSessionID" | "isSubagentSession" | "offeredCategories"
>

export const isIntentRoutingCaptureSessionEligible = isJevIntentRoutingSessionEligible

function isDelegationTool(tool: string): tool is IntentRoutingDelegationTool {
  return delegationTools.has(tool)
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function updateUnscorableCounters(
  counters: IntentRoutingCaptureCounters,
  routeClass: IntentRoutingRouteClass,
): IntentRoutingCaptureCounters {
  switch (routeClass) {
    case "unscorable_resume":
      return {
        ...counters,
        unscorableResumeCalls: counters.unscorableResumeCalls + 1,
      }
    case "unknown":
      return {
        ...counters,
        unscorableUnknownCalls: counters.unscorableUnknownCalls + 1,
      }
    case "none":
    case "category":
    case "subagent":
      return counters
  }
}

function appendObservation(
  record: IntentRoutingCaptureRecord,
  observation: IntentRoutingObservedDelegation,
): IntentRoutingCaptureRecord {
  const observed = [...record.observed, observation]
  const categories = new Set(
    observed
      .filter(({ routeClass }) => routeClass === "category")
      .map(({ normalizedCategory }) => normalizedCategory),
  )
  const subagents = new Set(
    observed
      .filter(({ routeClass }) => routeClass === "subagent")
      .map(({ normalizedSubagent }) => normalizedSubagent),
  )
  return {
    observed,
    observedAreAttempts: true,
    distinctCategoryCount: categories.size,
    distinctSubagentCount: subagents.size,
  }
}

export function captureIntentRoutingDelegationAttempt(
  args: IntentRoutingDelegationAttemptArgs,
): IntentRoutingObservedDelegation | null {
  if (
    !isDelegationTool(args.input.tool)
    || !isIntentRoutingCaptureSessionEligible({
      sessionID: args.input.sessionID,
      mainSessionID: args.mainSessionID,
      isSubagentSession: args.isSubagentSession,
    })
  ) return null

  const observedArgs = {
    category: args.output.args.category,
    subagent_type: args.output.args.subagent_type,
    requested_subagent_type: args.output.args.requested_subagent_type,
    task_id: args.output.args.task_id,
  }
  return {
    tool: args.input.tool,
    category: optionalString(observedArgs.category),
    subagentType: optionalString(observedArgs.subagent_type),
    requestedSubagentType: optionalString(observedArgs.requested_subagent_type),
    taskId: optionalString(observedArgs.task_id),
    ...normalizeObservedDelegation(observedArgs, args.offeredCategories),
    callID: args.input.callID,
  }
}

export function captureIntentRoutingDelegation(
  args: IntentRoutingCaptureArgs,
): IntentRoutingCaptureResult {
  const observation = captureIntentRoutingDelegationAttempt(args)
  if (observation === null) {
    return { captured: false, record: args.record, counters: args.counters }
  }
  const counters = updateUnscorableCounters(args.counters, observation.routeClass)

  if (args.record === null) {
    return {
      captured: false,
      record: null,
      counters: {
        ...counters,
        orphanObservations: counters.orphanObservations + 1,
      },
    }
  }

  return {
    captured: true,
    record: appendObservation(args.record, observation),
    counters,
  }
}
