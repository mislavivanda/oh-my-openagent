import { getSessionAgent } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { log } from "../../shared/logger"

import { acknowledgeCompactionGuard, isCompactionGuardActive } from "./compaction-guard"
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
  } = args

  const preflight = await runIdleEventPreflight({
    ctx,
    sessionID,
    sessionStateStore,
    backgroundManager,
    skipAgents,
    isContinuationStopped,
  })
  if (preflight.kind === "stop") return

  const {
    state,
    observedCompactionEpoch,
    prefetchedMessages,
    todos,
    incompleteCount,
  } = preflight

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
    log(`[${HOOK_NAME}] Failed to fetch messages for agent check`, { sessionID, error: loggedError })
  }

  if (latestMessageWasCompaction) {
    log(`[${HOOK_NAME}] Skipped: latest message is a compaction marker`, { sessionID })
    return
  }

  const sessionAgent = getSessionAgent(sessionID)
  if (!resolvedInfo?.agent && sessionAgent) {
    resolvedInfo = { ...resolvedInfo, agent: sessionAgent }
  }

  const acknowledgedCompaction = resolvedInfo?.agent ? acknowledgeCompactionGuard(state, observedCompactionEpoch) : false
  const compactionGuardActive = isCompactionGuardActive(state, Date.now())

  log(`[${HOOK_NAME}] Agent check`, {
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
    log(`[${HOOK_NAME}] Skipped: agent in skipAgents list`, { sessionID, agent: resolvedAgentName })
    return
  }
  if ((compactionGuardActive || encounteredCompaction) && !resolvedInfo?.agent) {
    log(`[${HOOK_NAME}] Skipped: compaction occurred but no agent info resolved`, { sessionID })
    return
  }
  if (compactionGuardActive) {
    log(`[${HOOK_NAME}] Skipped: compaction guard still armed for current epoch`, { sessionID, observedCompactionEpoch, currentCompactionEpoch: state.recentCompactionEpoch })
    return
  }

  if (isContinuationStopped?.(sessionID)) {
    log(`[${HOOK_NAME}] Skipped: continuation stopped for session`, { sessionID })
    return
  }

  const progressUpdate = sessionStateStore.trackContinuationProgress(
    sessionID,
    incompleteCount,
    todos,
  )
  if (state.continuationBlockReason) {
    log(`[${HOOK_NAME}] Skipped: continuation paused at turn boundary`, {
      sessionID,
      reason: state.continuationBlockReason,
      hasProgressed: progressUpdate.hasProgressed,
    })
    return
  }
  if (shouldStopForStagnation({ sessionID, incompleteCount, progressUpdate })) {
    return
  }
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
  })
}
