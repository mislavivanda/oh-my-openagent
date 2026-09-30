import { getSessionAgent } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { log as defaultLog } from "../../shared/logger"

import { acknowledgeCompactionGuard, isCompactionGuardActive } from "./compaction-guard"
import { NOOP_COMPLETION_CONTINUATION_OBSERVER } from "./completion-continuation-observer"
import { DEFAULT_SKIP_AGENTS, HOOK_NAME } from "./constants"
import { startCountdown } from "./countdown"
import { runIdleEventPreflight } from "./idle-event-preflight"
import type { HandleSessionIdleArgs } from "./idle-event-types"
import { resolveLatestMessageInfo } from "./resolve-message-info"
import { shouldStopForStagnation } from "./stagnation-detection"
import type { ResolvedMessageInfo } from "./types"

export async function handleSessionIdle(args: HandleSessionIdleArgs): Promise<void> {
  const {
    ctx,
    sessionID,
    sessionStateStore,
    backgroundManager,
    skipAgents = DEFAULT_SKIP_AGENTS,
    isContinuationStopped,
    completionContinuationObserver = NOOP_COMPLETION_CONTINUATION_OBSERVER,
    logger = defaultLog,
  } = args

  const preflight = await runIdleEventPreflight({
    ctx,
    sessionID,
    sessionStateStore,
    backgroundManager,
    skipAgents,
    isContinuationStopped,
    completionContinuationObserver,
    logger,
  })
  if (preflight.kind === "stop") return

  const {
    state,
    observedCompactionEpoch,
    prefetchedMessages,
    todos,
    incompleteCount,
    promiseComplete,
  } = preflight

  const finish = (
    gauntletOutcome: Parameters<typeof completionContinuationObserver.finishHeuristic>[1]["gauntletOutcome"],
    todoProgress: boolean | null,
    stagnationStop = false,
  ): void => completionContinuationObserver.finishHeuristic(sessionID, {
    gauntletOutcome,
    todoComplete: false,
    promiseComplete,
    todoProgress,
    stagnationStop,
  })

  let resolvedInfo: ResolvedMessageInfo | undefined
  let encounteredCompaction = false
  let latestMessageWasCompaction = false
  try {
    const messageInfoResult = await resolveLatestMessageInfo(ctx, sessionID, prefetchedMessages)
    resolvedInfo = messageInfoResult.resolvedInfo
    encounteredCompaction = messageInfoResult.encounteredCompaction
    latestMessageWasCompaction = messageInfoResult.latestMessageWasCompaction
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    logger(`[${HOOK_NAME}] Failed to fetch messages for agent check`, { sessionID, error: loggedError })
  }

  if (latestMessageWasCompaction) {
    logger(`[${HOOK_NAME}] Skipped: latest message is a compaction marker`, { sessionID })
    finish("latest_compaction", null)
    return
  }

  const sessionAgent = getSessionAgent(sessionID)
  if (!resolvedInfo?.agent && sessionAgent) {
    resolvedInfo = { ...resolvedInfo, agent: sessionAgent }
  }

  const acknowledgedCompaction = resolvedInfo?.agent ? acknowledgeCompactionGuard(state, observedCompactionEpoch) : false
  const compactionGuardActive = isCompactionGuardActive(state, Date.now())

  logger(`[${HOOK_NAME}] Agent check`, {
    sessionID,
    agentName: resolvedInfo?.agent,
    skipAgents,
    compactionGuardActive,
    observedCompactionEpoch,
    currentCompactionEpoch: state.recentCompactionEpoch,
    acknowledgedCompaction,
  })

  const resolvedAgentName = resolvedInfo?.agent
  if (resolvedAgentName && skipAgents.some(s => getAgentConfigKey(s) === getAgentConfigKey(resolvedAgentName))) {
    logger(`[${HOOK_NAME}] Skipped: agent in skipAgents list`, { sessionID, agent: resolvedAgentName })
    finish("agent_skipped", null)
    return
  }
  if ((compactionGuardActive || encounteredCompaction) && !resolvedInfo?.agent) {
    logger(`[${HOOK_NAME}] Skipped: compaction occurred but no agent info resolved`, { sessionID })
    finish("compaction_agent_unknown", null)
    return
  }
  if (compactionGuardActive) {
    logger(`[${HOOK_NAME}] Skipped: compaction guard still armed for current epoch`, { sessionID, observedCompactionEpoch, currentCompactionEpoch: state.recentCompactionEpoch })
    finish("compaction_guard", null)
    return
  }

  if (isContinuationStopped?.(sessionID)) {
    logger(`[${HOOK_NAME}] Skipped: continuation stopped for session`, { sessionID })
    finish("continuation_stopped", null)
    return
  }

  const progressUpdate = sessionStateStore.trackContinuationProgress(
    sessionID,
    incompleteCount,
    todos,
  )
  if (state.continuationBlockReason) {
    logger(`[${HOOK_NAME}] Skipped: continuation paused at turn boundary`, {
      sessionID,
      reason: state.continuationBlockReason,
      hasProgressed: progressUpdate.hasProgressed,
    })
    finish("turn_boundary_block", progressUpdate.hasProgressed)
    return
  }
  const stagnationStop = shouldStopForStagnation({ sessionID, incompleteCount, progressUpdate, logger })
  if (stagnationStop) {
    finish("stagnation_stop", progressUpdate.hasProgressed, true)
    return
  }
  finish("continuation_scheduled", progressUpdate.hasProgressed)
  startCountdown({
    ctx,
    sessionID,
    incompleteCount,
    total: todos.length,
    resolvedInfo,
    backgroundManager,
    skipAgents,
    sessionStateStore,
    isContinuationStopped,
    logger,
  })
}
