import {
  normalizeObservedDelegation,
  type IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"
import { isJevIntentRoutingSessionEligible } from "./intent-routing-session-gate"

export const JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST = Object.freeze([
  "task",
  "call_omo_agent",
] as const)

const CAPTURE_TOOLS: ReadonlySet<string> = new Set(
  JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST,
)

type IntentRoutingObservationAppender = Readonly<{
  appendObservation(
    sessionID: string,
    observation: IntentRoutingObservedDelegation,
  ): boolean
}>

type ToolExecuteBeforeInput = Readonly<{
  tool: string
  sessionID: string
  callID: string
}>

type ToolExecuteBeforeOutput = Readonly<{
  args: Record<string, unknown>
}>

export type JevIntentRoutingCapture = Readonly<{
  readonly unscorableResumeCalls: number
  readonly unscorableUnknownCalls: number
  capture(
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ): boolean
}>

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export function createJevIntentRoutingCapture(
  store: IntentRoutingObservationAppender,
): JevIntentRoutingCapture {
  let unscorableResumeCalls = 0
  let unscorableUnknownCalls = 0

  return {
    get unscorableResumeCalls() {
      return unscorableResumeCalls
    },
    get unscorableUnknownCalls() {
      return unscorableUnknownCalls
    },
    capture(input, output) {
      if (!CAPTURE_TOOLS.has(input.tool)) return false
      if (!isJevIntentRoutingSessionEligible(input.sessionID)) return false

      const category = output.args.category
      const subagentType = output.args.subagent_type
      const requestedSubagentType = output.args.requested_subagent_type
      const taskId = output.args.task_id
      const normalized = normalizeObservedDelegation({
        tool: input.tool,
        category,
        subagent_type: subagentType,
        requested_subagent_type: requestedSubagentType,
        task_id: taskId,
      })
      const observation: IntentRoutingObservedDelegation = Object.freeze({
        tool: input.tool,
        category: stringOrNull(category),
        subagentType: stringOrNull(subagentType),
        requestedSubagentType: stringOrNull(requestedSubagentType),
        taskId: stringOrNull(taskId),
        ...normalized,
        callID: input.callID,
      })
      const captured = store.appendObservation(input.sessionID, observation)
      if (captured && normalized.routeClass === "unscorable_resume") {
        unscorableResumeCalls += 1
      }
      if (captured && normalized.routeClass === "unknown") {
        unscorableUnknownCalls += 1
      }
      return captured
    },
  }
}
