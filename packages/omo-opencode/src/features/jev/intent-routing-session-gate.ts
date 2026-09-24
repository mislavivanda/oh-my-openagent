import { getMainSessionID, subagentSessions } from "../claude-code-session-state"

export type JevIntentRoutingSessionGateInput = {
  readonly sessionID: string
  readonly mainSessionID: string | undefined
  readonly isSubagentSession: boolean
}

export type JevIntentRoutingSessionGateReason =
  | "main_session_unknown"
  | "subagent_session"
  | "non_main_session"

function resolveGateInput(
  input: string | JevIntentRoutingSessionGateInput,
): JevIntentRoutingSessionGateInput {
  if (typeof input !== "string") return input
  return {
    sessionID: input,
    mainSessionID: getMainSessionID(),
    isSubagentSession: subagentSessions.has(input),
  }
}

export function getJevIntentRoutingSessionGateReason(
  input: string | JevIntentRoutingSessionGateInput,
): JevIntentRoutingSessionGateReason | null {
  const gateInput = resolveGateInput(input)
  if (gateInput.isSubagentSession) return "subagent_session"
  if (gateInput.mainSessionID === undefined) return "main_session_unknown"
  return gateInput.sessionID === gateInput.mainSessionID ? null : "non_main_session"
}

export function isJevIntentRoutingSessionEligible(
  input: string | JevIntentRoutingSessionGateInput,
): boolean {
  return getJevIntentRoutingSessionGateReason(input) === null
}
