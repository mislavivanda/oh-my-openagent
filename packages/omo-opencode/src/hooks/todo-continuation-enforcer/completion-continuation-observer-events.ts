import { resolveMessageEventSessionID } from "../../shared/event-session-id"
import type { InternalInitiatorTextPartLike } from "../../shared/internal-initiator-marker"
import { isSyntheticOrInternalOnlyTextParts } from "../../shared/internal-initiator-marker"

import type { CompletionContinuationObserver } from "./completion-continuation-observer"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventParts(properties: Record<string, unknown> | undefined): InternalInitiatorTextPartLike[] | undefined {
  const parts = properties?.parts
  if (!Array.isArray(parts)) return undefined
  const parsed: InternalInitiatorTextPartLike[] = []
  for (const candidate of parts) {
    if (!isRecord(candidate)) return undefined
    const part = candidate
    if (part.type !== undefined && typeof part.type !== "string") return undefined
    if (part.text !== undefined && typeof part.text !== "string") return undefined
    if (part.synthetic !== undefined && typeof part.synthetic !== "boolean") return undefined
    parsed.push({
      ...(typeof part.type === "string" ? { type: part.type } : {}),
      ...(typeof part.text === "string" ? { text: part.text } : {}),
      ...(typeof part.synthetic === "boolean" ? { synthetic: part.synthetic } : {}),
    })
  }
  return parsed
}

export function observeCompletionContinuationNonIdleEvent(args: {
  readonly eventType: string
  readonly properties: Record<string, unknown> | undefined
  readonly observer: CompletionContinuationObserver
}): void {
  const { eventType, properties, observer } = args
  const sessionID = resolveMessageEventSessionID(properties)
  if (!sessionID) return

  if (eventType === "message.updated") {
    const info = isRecord(properties?.info) ? properties.info : undefined
    if (info?.role === "assistant") {
      observer.markContinuationActivity(sessionID, true)
    } else if (info?.role === "user" && !isSyntheticOrInternalOnlyTextParts(eventParts(properties))) {
      observer.humanIntervention(sessionID)
    }
    return
  }

  if (eventType === "message.part.updated" || eventType === "message.part.delta") {
    const info = isRecord(properties?.info) ? properties.info : undefined
    if (info?.role === "assistant") observer.markContinuationActivity(sessionID, true)
    if (info?.role === "user" && !isSyntheticOrInternalOnlyTextParts(eventParts(properties))) {
      observer.humanIntervention(sessionID)
    }
    return
  }

  if (eventType === "tool.execute.before") {
    observer.markContinuationActivity(sessionID, false)
  } else if (eventType === "tool.execute.after") {
    observer.markContinuationActivity(sessionID, true)
  }
}
