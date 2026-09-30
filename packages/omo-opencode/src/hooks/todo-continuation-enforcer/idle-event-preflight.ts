import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"
import { latestAssistantTurnBlocksInternalPrompt } from "../../shared/prompt-async-gate/pending-tool-turn"

import { isLastAssistantMessageAborted } from "./abort-detection"
import { ABORT_WINDOW_MS, CONTINUATION_COOLDOWN_MS, FAILURE_RESET_WINDOW_MS, HOOK_NAME, MAX_CONSECUTIVE_FAILURES } from "./constants"
import type { IdleEventContext, IdleEventPreflightResult } from "./idle-event-types"
import { hasUnansweredQuestion } from "./pending-question-detection"
import { getIncompleteCount } from "./todo"
import type { MessageWithInfo, Todo } from "./types"

const STOP_PREFLIGHT = { kind: "stop" } as const

export async function runIdleEventPreflight(args: IdleEventContext): Promise<IdleEventPreflightResult> {
  const { ctx, sessionID, sessionStateStore, backgroundManager } = args

  log(`[${HOOK_NAME}] session.idle`, { sessionID })

  const state = sessionStateStore.getState(sessionID)
  const observedCompactionEpoch = state.recentCompactionEpoch

  if (state.allTodosCompletedAt) {
    log(`[${HOOK_NAME}] Skipped: all todos were already completed`, { sessionID, allTodosCompletedAt: state.allTodosCompletedAt })
    return STOP_PREFLIGHT
  }

  if (state.isRecovering) {
    log(`[${HOOK_NAME}] Skipped: in recovery`, { sessionID })
    return STOP_PREFLIGHT
  }

  if (state.wasCancelled) {
    log(`[${HOOK_NAME}] Skipped: session was cancelled`, { sessionID })
    return STOP_PREFLIGHT
  }

  if (handedBackSyncSessions.has(sessionID)) {
    log(`[${HOOK_NAME}] Skipped: sync subagent already handed back to parent`, { sessionID })
    return STOP_PREFLIGHT
  }

  if (state.tokenLimitDetected) {
    log(`[${HOOK_NAME}] Skipped: token limit error detected, retry would worsen context overflow`, { sessionID })
    return STOP_PREFLIGHT
  }

  if (state.abortDetectedAt) {
    const timeSinceAbort = Date.now() - state.abortDetectedAt
    if (timeSinceAbort < ABORT_WINDOW_MS) {
      log(`[${HOOK_NAME}] Skipped: abort detected via event ${timeSinceAbort}ms ago`, { sessionID })
      state.abortDetectedAt = undefined
      return STOP_PREFLIGHT
    }
    state.abortDetectedAt = undefined
  }

  const hasRunningBgTasks = backgroundManager
    ? backgroundManager.getTasksByParentSession(sessionID).some((task: { status: string }) => task.status === "running" || task.status === "pending")
      || backgroundManager.hasPendingParentWake?.(sessionID) === true
    : false

  if (hasRunningBgTasks) {
    log(`[${HOOK_NAME}] Skipped: background tasks running`, { sessionID })
    return STOP_PREFLIGHT
  }

  let prefetchedMessages: MessageWithInfo[] = []
  try {
    const messagesResp = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    })
    prefetchedMessages = normalizeSDKResponse(messagesResp, [] as MessageWithInfo[])
    if (isLastAssistantMessageAborted(prefetchedMessages)) {
      log(`[${HOOK_NAME}] Skipped: last assistant message was aborted (API fallback)`, { sessionID })
      return STOP_PREFLIGHT
    }
    if (hasUnansweredQuestion(prefetchedMessages)) {
      log(`[${HOOK_NAME}] Skipped: pending question awaiting user response`, { sessionID })
      return STOP_PREFLIGHT
    }
    if (latestAssistantTurnBlocksInternalPrompt(prefetchedMessages)) {
      log(`[${HOOK_NAME}] Skipped: pending internal continuation response`, { sessionID })
      return STOP_PREFLIGHT
    }
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    log(`[${HOOK_NAME}] Messages fetch failed, skipping continuation`, { sessionID, error: loggedError })
    return STOP_PREFLIGHT
  }

  let todos: Todo[] = []
  try {
    const response = await ctx.client.session.todo({ path: { id: sessionID } })
    todos = normalizeSDKResponse(response, [] as Todo[], { preferResponseOnMissingData: true })
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    log(`[${HOOK_NAME}] Todo fetch failed`, { sessionID, error: loggedError })
    return STOP_PREFLIGHT
  }

  if (!todos || todos.length === 0) {
    sessionStateStore.resetContinuationProgress(sessionID)
    log(`[${HOOK_NAME}] No todos`, { sessionID })
    return STOP_PREFLIGHT
  }

  const incompleteCount = getIncompleteCount(todos)
  if (incompleteCount === 0) {
    state.allTodosCompletedAt = Date.now()
    sessionStateStore.resetContinuationProgress(sessionID)
    log(`[${HOOK_NAME}] All todos complete`, { sessionID, total: todos.length })
    return STOP_PREFLIGHT
  }

  if (state.inFlight) {
    log(`[${HOOK_NAME}] Skipped: injection in flight`, { sessionID })
    return STOP_PREFLIGHT
  }

  if (
    state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    && state.lastInjectedAt
    && Date.now() - state.lastInjectedAt >= FAILURE_RESET_WINDOW_MS
  ) {
    state.consecutiveFailures = 0
    log(`[${HOOK_NAME}] Reset consecutive failures after recovery window`, { sessionID, failureResetWindowMs: FAILURE_RESET_WINDOW_MS })
  }

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    log(`[${HOOK_NAME}] Skipped: max consecutive failures reached`, { sessionID, consecutiveFailures: state.consecutiveFailures })
    return STOP_PREFLIGHT
  }

  const effectiveCooldown =
    CONTINUATION_COOLDOWN_MS * 2 ** Math.min(state.consecutiveFailures, 5)
  if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < effectiveCooldown) {
    log(`[${HOOK_NAME}] Skipped: cooldown active`, { sessionID, effectiveCooldown, consecutiveFailures: state.consecutiveFailures })
    return STOP_PREFLIGHT
  }

  return {
    kind: "continue",
    state,
    observedCompactionEpoch,
    prefetchedMessages,
    todos,
    incompleteCount,
  }
}
