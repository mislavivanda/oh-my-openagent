import type {
  CompletionContinuationHeuristicFacts,
  CompletionContinuationPreInputSkipReason,
} from "@oh-my-opencode/jev-core"

import { containsCompletionPromise } from "../../shared"
import { log } from "../../shared/logger"

import { HOOK_NAME } from "./constants"
import type { MessageWithInfo, Todo } from "./types"

export type CompletionContinuationObserverEvent = {
  readonly type: string
  readonly properties?: unknown
}

export type CompletionContinuationObserverIdleInput = {
  readonly sessionID: string
  readonly directory: string
  readonly todos: readonly Todo[]
  readonly transcript: readonly MessageWithInfo[]
  readonly isContinuationCandidate: boolean
}

export interface CompletionContinuationObserver {
  observeEvent(event: CompletionContinuationObserverEvent): void
  recordPreInputSkip(reason: CompletionContinuationPreInputSkipReason): void
  beginIdle(input: CompletionContinuationObserverIdleInput): void
  finishHeuristic(sessionID: string, facts: CompletionContinuationHeuristicFacts): void
  markContinuationActivity(sessionID: string, successful: boolean): void
  humanIntervention(sessionID: string): void
  deleteSession(sessionID: string): void
  dispose(): void
}

export const NOOP_COMPLETION_CONTINUATION_OBSERVER: CompletionContinuationObserver = {
  observeEvent: () => {},
  recordPreInputSkip: () => {},
  beginIdle: () => {},
  finishHeuristic: () => {},
  markContinuationActivity: () => {},
  humanIntervention: () => {},
  deleteSession: () => {},
  dispose: () => {},
}

function invokeObserver(method: string, callback: () => void): void {
  try {
    callback()
  } catch (error) {
    log(`[${HOOK_NAME}] Completion-continuation observer failed`, {
      method,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    })
  }
}

export function createSafeCompletionContinuationObserver(
  observer: CompletionContinuationObserver,
): CompletionContinuationObserver {
  return {
    observeEvent: (event) => invokeObserver("observeEvent", () => observer.observeEvent(event)),
    recordPreInputSkip: (reason) => invokeObserver("recordPreInputSkip", () => observer.recordPreInputSkip(reason)),
    beginIdle: (input) => invokeObserver("beginIdle", () => observer.beginIdle(input)),
    finishHeuristic: (sessionID, facts) => invokeObserver(
      "finishHeuristic",
      () => observer.finishHeuristic(sessionID, facts),
    ),
    markContinuationActivity: (sessionID, successful) => invokeObserver(
      "markContinuationActivity",
      () => observer.markContinuationActivity(sessionID, successful),
    ),
    humanIntervention: (sessionID) => invokeObserver(
      "humanIntervention",
      () => observer.humanIntervention(sessionID),
    ),
    deleteSession: (sessionID) => invokeObserver("deleteSession", () => observer.deleteSession(sessionID)),
    dispose: () => invokeObserver("dispose", () => observer.dispose()),
  }
}

export function hasDefaultCompletionPromise(messages: readonly MessageWithInfo[]): boolean {
  return messages.some((message) => message.info?.role === "assistant"
    && message.parts?.some((part) => part.type === "text"
      && typeof part.text === "string"
      && containsCompletionPromise(part.text, "DONE")) === true)
}
