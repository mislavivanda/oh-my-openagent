import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import type {
  CompletionContinuationGauntletOutcome,
  CompletionContinuationPreInputSkipReason,
} from "@oh-my-opencode/jev-core"
import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"
import { latestAssistantTurnBlocksInternalPrompt } from "../../shared/prompt-async-gate/pending-tool-turn"

import { isLastAssistantMessageAborted } from "./abort-detection"
import { hasDefaultCompletionPromise } from "./completion-continuation-observer"
import { ABORT_WINDOW_MS, CONTINUATION_COOLDOWN_MS, FAILURE_RESET_WINDOW_MS, HOOK_NAME, MAX_CONSECUTIVE_FAILURES } from "./constants"
import type { IdleEventContext, IdleEventPreflightResult } from "./idle-event-types"
import { hasUnansweredQuestion } from "./pending-question-detection"
import { getIncompleteCount } from "./todo"
import type { MessageWithInfo, Todo } from "./types"

const STOP_PREFLIGHT = { kind: "stop" } as const

function stopBeforeInput(
  observer: IdleEventContext["completionContinuationObserver"],
  reason: CompletionContinuationPreInputSkipReason,
): IdleEventPreflightResult {
  observer.recordPreInputSkip(reason)
  return STOP_PREFLIGHT
}

function finishPostInput(args: {
  readonly observer: IdleEventContext["completionContinuationObserver"]
  readonly sessionID: string
  readonly outcome: CompletionContinuationGauntletOutcome
  readonly todoComplete: boolean | null
  readonly promiseComplete: boolean
}): IdleEventPreflightResult {
  args.observer.finishHeuristic(args.sessionID, {
    gauntletOutcome: args.outcome,
    todoComplete: args.todoComplete,
    promiseComplete: args.promiseComplete,
    todoProgress: null,
    stagnationStop: false,
  })
  return STOP_PREFLIGHT
}

export async function runIdleEventPreflight(args: IdleEventContext): Promise<IdleEventPreflightResult> {
  const { ctx, sessionID, sessionStateStore, backgroundManager, completionContinuationObserver } = args

  log(`[${HOOK_NAME}] session.idle`, { sessionID })

  const state = sessionStateStore.getState(sessionID)
  const observedCompactionEpoch = state.recentCompactionEpoch

  if (state.allTodosCompletedAt) {
    log(`[${HOOK_NAME}] Skipped: all todos were already completed`, { sessionID, allTodosCompletedAt: state.allTodosCompletedAt })
    return stopBeforeInput(completionContinuationObserver, "alreadyComplete")
  }

  if (state.isRecovering) {
    log(`[${HOOK_NAME}] Skipped: in recovery`, { sessionID })
    return stopBeforeInput(completionContinuationObserver, "recovering")
  }

  if (state.wasCancelled) {
    log(`[${HOOK_NAME}] Skipped: session was cancelled`, { sessionID })
    return stopBeforeInput(completionContinuationObserver, "cancelled")
  }

  if (handedBackSyncSessions.has(sessionID)) {
    log(`[${HOOK_NAME}] Skipped: sync subagent already handed back to parent`, { sessionID })
    return stopBeforeInput(completionContinuationObserver, "syncHandoff")
  }

  if (state.tokenLimitDetected) {
    log(`[${HOOK_NAME}] Skipped: token limit error detected, retry would worsen context overflow`, { sessionID })
    return stopBeforeInput(completionContinuationObserver, "tokenLimit")
  }

  if (state.abortDetectedAt) {
    const timeSinceAbort = Date.now() - state.abortDetectedAt
    if (timeSinceAbort < ABORT_WINDOW_MS) {
      log(`[${HOOK_NAME}] Skipped: abort detected via event ${timeSinceAbort}ms ago`, { sessionID })
      state.abortDetectedAt = undefined
      return stopBeforeInput(completionContinuationObserver, "recentAbort")
    }
    state.abortDetectedAt = undefined
  }

  const hasRunningBgTasks = backgroundManager
    ? backgroundManager.getTasksByParentSession(sessionID).some((task: { status: string }) => task.status === "running" || task.status === "pending")
      || backgroundManager.hasPendingParentWake?.(sessionID) === true
    : false

  if (hasRunningBgTasks) {
    log(`[${HOOK_NAME}] Skipped: background tasks running`, { sessionID })
    return stopBeforeInput(completionContinuationObserver, "backgroundTasks")
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
      return stopBeforeInput(completionContinuationObserver, "assistantAborted")
    }
    if (hasUnansweredQuestion(prefetchedMessages)) {
      log(`[${HOOK_NAME}] Skipped: pending question awaiting user response`, { sessionID })
      return stopBeforeInput(completionContinuationObserver, "pendingQuestion")
    }
    if (latestAssistantTurnBlocksInternalPrompt(prefetchedMessages)) {
      log(`[${HOOK_NAME}] Skipped: pending internal continuation response`, { sessionID })
      return stopBeforeInput(completionContinuationObserver, "internalContinuationPending")
    }
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    log(`[${HOOK_NAME}] Messages fetch failed, skipping continuation`, { sessionID, error: loggedError })
    return stopBeforeInput(completionContinuationObserver, "messagesUnavailable")
  }

  let todos: Todo[] = []
  try {
    const response = await ctx.client.session.todo({ path: { id: sessionID } })
    todos = normalizeSDKResponse(response, [] as Todo[], { preferResponseOnMissingData: true })
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    log(`[${HOOK_NAME}] Todo fetch failed`, { sessionID, error: loggedError })
    return stopBeforeInput(completionContinuationObserver, "todosUnavailable")
  }

  const promiseComplete = hasDefaultCompletionPromise(prefetchedMessages)
  const incompleteCount = getIncompleteCount(todos)
  completionContinuationObserver.beginIdle({
    sessionID,
    directory: ctx.directory,
    todos,
    transcript: prefetchedMessages,
    isContinuationCandidate: incompleteCount > 0,
  })

  if (!todos || todos.length === 0) {
    sessionStateStore.resetContinuationProgress(sessionID)
    log(`[${HOOK_NAME}] No todos`, { sessionID })
    return finishPostInput({
      observer: completionContinuationObserver,
      sessionID,
      outcome: "no_todos",
      todoComplete: null,
      promiseComplete,
    })
  }

  if (incompleteCount === 0) {
    state.allTodosCompletedAt = Date.now()
    sessionStateStore.resetContinuationProgress(sessionID)
    log(`[${HOOK_NAME}] All todos complete`, { sessionID, total: todos.length })
    return finishPostInput({
      observer: completionContinuationObserver,
      sessionID,
      outcome: "all_todos_complete",
      todoComplete: true,
      promiseComplete,
    })
  }

  if (state.inFlight) {
    log(`[${HOOK_NAME}] Skipped: injection in flight`, { sessionID })
    return finishPostInput({ observer: completionContinuationObserver, sessionID, outcome: "injection_in_flight", todoComplete: false, promiseComplete })
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
    return finishPostInput({ observer: completionContinuationObserver, sessionID, outcome: "max_failures", todoComplete: false, promiseComplete })
  }

  const effectiveCooldown =
    CONTINUATION_COOLDOWN_MS * 2 ** Math.min(state.consecutiveFailures, 5)
  if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < effectiveCooldown) {
    log(`[${HOOK_NAME}] Skipped: cooldown active`, { sessionID, effectiveCooldown, consecutiveFailures: state.consecutiveFailures })
    return finishPostInput({ observer: completionContinuationObserver, sessionID, outcome: "cooldown", todoComplete: false, promiseComplete })
  }

  return {
    kind: "continue",
    state,
    observedCompactionEpoch,
    prefetchedMessages,
    todos,
    incompleteCount,
    promiseComplete,
  }
}
