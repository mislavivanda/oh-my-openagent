import type { HookName, OhMyOpenCodeConfig } from "../../config"
import type { BackgroundManager } from "../../features/background-agent"
import { createJevCompletionContinuation } from "../../features/jev"
import type { PluginContext } from "../types"

import {
  createTodoContinuationEnforcer,
  createBackgroundNotificationHook,
  createStopContinuationGuardHook,
  createCompactionContextInjector,
  createCompactionTodoPreserverHook,
  createAtlasHook,
  NOOP_COMPLETION_CONTINUATION_OBSERVER,
  type CompletionContinuationObserver,
} from "../../hooks"
import { log } from "../../shared/logger"
import { safeCreateHook } from "../../shared/safe-create-hook"
import { createUnstableAgentBabysitter } from "../unstable-agent-babysitter"

export type ContinuationHooks = {
  stopContinuationGuard: ReturnType<typeof createStopContinuationGuardHook> | null
  compactionContextInjector: ReturnType<typeof createCompactionContextInjector> | null
  compactionTodoPreserver: ReturnType<typeof createCompactionTodoPreserverHook> | null
  todoContinuationEnforcer: ReturnType<typeof createTodoContinuationEnforcer> | null
  unstableAgentBabysitter: ReturnType<typeof createUnstableAgentBabysitter> | null
  backgroundNotificationHook: ReturnType<typeof createBackgroundNotificationHook> | null
  atlasHook: ReturnType<typeof createAtlasHook> | null
}

type ContinuationHookLogger = (message: string, data?: unknown) => void

function createCompletionContinuationObserver(
  pluginConfig: OhMyOpenCodeConfig,
  logger: ContinuationHookLogger,
): CompletionContinuationObserver {
  try {
    const jevConfig = pluginConfig.jev
    if (
      jevConfig?.enabled !== true
      || jevConfig.wires.completion_continuation.enabled !== true
    ) {
      return NOOP_COMPLETION_CONTINUATION_OBSERVER
    }
    const completionContinuation = createJevCompletionContinuation({ jevConfig })
    return {
      observeEvent: completionContinuation.observeEvent,
      recordPreInputSkip: completionContinuation.recordPreInputSkip,
      beginIdle: (input) => { completionContinuation.beginIdle(input) },
      finishHeuristic: (sessionID, facts) => { completionContinuation.finishHeuristic(sessionID, facts) },
      markContinuationActivity: (sessionID, successful) => {
        completionContinuation.markContinuationActivity(sessionID, successful)
      },
      humanIntervention: (sessionID) => { completionContinuation.humanIntervention(sessionID) },
      deleteSession: completionContinuation.deleteSession,
      dispose: () => {
        void completionContinuation.dispose().catch((error) => {
          logger("[jev] completion-continuation observer dispose failed", { error: String(error) })
        })
      },
    }
  } catch (error) {
    logger("[jev] completion-continuation observer construction failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NOOP_COMPLETION_CONTINUATION_OBSERVER
  }
}

export function createContinuationHooks(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  isHookEnabled: (hookName: HookName) => boolean
  safeHookEnabled: boolean
  backgroundManager: BackgroundManager
  logger?: ContinuationHookLogger
}): ContinuationHooks {
  const {
    ctx,
    pluginConfig,
    isHookEnabled,
    safeHookEnabled,
    backgroundManager,
    logger = log,
  } = args

  const safeHook = <T>(hookName: HookName, factory: () => T): T | null =>
    safeCreateHook(hookName, factory, { enabled: safeHookEnabled })

  const stopContinuationGuard = isHookEnabled("stop-continuation-guard")
    ? safeHook("stop-continuation-guard", () =>
        createStopContinuationGuardHook(ctx, {
          backgroundManager,
        }))
    : null

  const compactionContextInjector = isHookEnabled("compaction-context-injector")
    ? safeHook("compaction-context-injector", () =>
        createCompactionContextInjector({ ctx, backgroundManager }))
    : null

  const compactionTodoPreserver = isHookEnabled("compaction-todo-preserver")
    ? safeHook("compaction-todo-preserver", () => createCompactionTodoPreserverHook(ctx))
    : null

  const todoContinuationEnforcer = isHookEnabled("todo-continuation-enforcer")
    ? safeHook("todo-continuation-enforcer", () => {
      const completionContinuationObserver = createCompletionContinuationObserver(pluginConfig, logger)
      return createTodoContinuationEnforcer(ctx, {
          backgroundManager,
          isContinuationStopped: stopContinuationGuard?.isStopped,
          completionContinuationObserver,
        })
      })
    : null

  const unstableAgentBabysitter = isHookEnabled("unstable-agent-babysitter")
    ? safeHook("unstable-agent-babysitter", () =>
        createUnstableAgentBabysitter({ ctx, backgroundManager, pluginConfig }))
    : null

  const backgroundNotificationHook = isHookEnabled("background-notification")
    ? safeHook("background-notification", () => createBackgroundNotificationHook(backgroundManager))
    : null

  const atlasHook = isHookEnabled("atlas")
    ? safeHook("atlas", () =>
        createAtlasHook(ctx, {
          directory: ctx.directory,
          backgroundManager,
          isContinuationStopped: (sessionID: string) =>
            stopContinuationGuard?.isStopped(sessionID) ?? false,
          agentOverrides: pluginConfig.agents,
          autoCommit: pluginConfig.start_work?.auto_commit,
        }))
    : null

  return {
    stopContinuationGuard,
    compactionContextInjector,
    compactionTodoPreserver,
    todoContinuationEnforcer,
    unstableAgentBabysitter,
    backgroundNotificationHook,
    atlasHook,
  }
}
