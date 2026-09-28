import { getMainSessionID, subagentSessions } from "../claude-code-session-state/state"

export type JevIntentRoutingNotDispatchedReason =
  | "main_session_unknown"
  | "non_main_session"
  | "subagent_session"
  | "max_inflight"

export function getJevIntentRoutingSessionGateReason(
  sessionID: string,
): Exclude<JevIntentRoutingNotDispatchedReason, "max_inflight"> | null {
  const mainSessionID = getMainSessionID()
  if (mainSessionID === undefined) return "main_session_unknown"
  if (subagentSessions.has(sessionID)) return "subagent_session"
  if (sessionID !== mainSessionID) return "non_main_session"
  return null
}

export function isJevIntentRoutingSessionEligible(sessionID: string): boolean {
  return getJevIntentRoutingSessionGateReason(sessionID) === null
}
