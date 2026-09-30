import { normalizeObservedDelegation } from "@oh-my-opencode/jev-core"
import { isJevIntentRoutingSessionEligible } from "./intent-routing"
import type { IntentRoutingTurnStore } from "./intent-routing-turn-types"

export const JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST = Object.freeze([
  "task",
  "call_omo_agent",
] as const)

type JevIntentRoutingCaptureInput = {
  readonly tool?: unknown
  readonly sessionID?: unknown
  readonly callID?: unknown
}

type JevIntentRoutingCaptureOutput = {
  readonly args?: unknown
}

export type JevIntentRoutingCapture = {
  capture(
    input: JevIntentRoutingCaptureInput,
    output: JevIntentRoutingCaptureOutput | null | undefined,
  ): boolean
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCaptureTool(tool: unknown): tool is typeof JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST[number] {
  return typeof tool === "string"
    && JEV_INTENT_ROUTING_CAPTURE_TOOL_ALLOWLIST.some((candidate) => candidate === tool)
}

function latestLiveTurnOrdinal(
  turnStore: Pick<IntentRoutingTurnStore, "getSessionTurns">,
  sessionID: string,
): number | undefined {
  const turns = turnStore.getSessionTurns(sessionID)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.terminalState === "live") return turn.turnOrdinal
  }
  return undefined
}

export function createJevIntentRoutingCapture(args: {
  readonly turnStore: Pick<IntentRoutingTurnStore, "appendObservation" | "getSessionTurns">
}): JevIntentRoutingCapture {
  return {
    capture(input, output): boolean {
      if (!isCaptureTool(input.tool)) return false
      if (!isJevIntentRoutingSessionEligible(input.sessionID)) return false

      const toolArgs = isRecord(output?.args) ? output.args : {}
      const observation = normalizeObservedDelegation({
        tool: input.tool,
        category: toolArgs.category,
        subagent_type: toolArgs.subagent_type,
        requested_subagent_type: toolArgs.requested_subagent_type,
        task_id: toolArgs.task_id,
        callID: input.callID,
      })
      const turnOrdinal = latestLiveTurnOrdinal(args.turnStore, input.sessionID)

      return args.turnStore.appendObservation(
        input.sessionID,
        turnOrdinal ?? -1,
        observation,
      )
    },
  }
}
