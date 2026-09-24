import type { DecisionBackend } from "@oh-my-opencode/jev-core"
import { isRealUserTextPart } from "../../shared"
import { getMainSessionID, subagentSessions } from "../claude-code-session-state"

export type JevIntentRoutingMessagePart = {
  readonly type?: string
  readonly text?: string
  readonly synthetic?: boolean
}

export type JevIntentRoutingMessageOutput = {
  readonly parts?: readonly JevIntentRoutingMessagePart[]
}

export type IntentRoutingNotDispatchedReason =
  | "invalid_session_id"
  | "main_session_unknown"
  | "subagent_session"
  | "non_main_session"
  | "no_user_text"
  | "max_inflight"

export function intentRoutingSessionNotDispatchedReason(
  sessionID: unknown,
): IntentRoutingNotDispatchedReason | null {
  if (typeof sessionID !== "string" || sessionID.length === 0) return "invalid_session_id"
  const mainSessionID = getMainSessionID()
  if (mainSessionID === undefined) return "main_session_unknown"
  if (subagentSessions.has(sessionID)) return "subagent_session"
  if (sessionID !== mainSessionID) return "non_main_session"
  return null
}

export function isJevIntentRoutingSessionEligible(sessionID: unknown): sessionID is string {
  return intentRoutingSessionNotDispatchedReason(sessionID) === null
}

export function snapshotIntentRoutingPromptText(
  parts: JevIntentRoutingMessageOutput["parts"],
  maxChars: number,
): string {
  if (!Array.isArray(parts)) return ""
  let snapshot = ""
  let hasTextPart = false
  for (const part of parts) {
    if (!isRealUserTextPart(part)) continue
    const separator = hasTextPart ? "\n" : ""
    const remaining = maxChars - snapshot.length
    if (remaining <= 0) break
    snapshot += `${separator}${part.text}`.slice(0, remaining)
    hasTextPart = true
  }
  return snapshot
}

export function safeIntentRoutingBackendKind(backend: DecisionBackend): string {
  try {
    return backend.kind
  } catch {
    return "unknown"
  }
}
