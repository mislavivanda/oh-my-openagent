import type { JevConfig } from "./config/schema/jev"
import {
  createJevIntentRouting,
  JEV_INTENT_ROUTING_VOCABULARY,
  type JevIntentRouting,
} from "./features/jev"
import { log } from "./shared"

export type PluginDispose = () => Promise<void>

export function createPluginDispose(args: {
  backgroundManager: {
    shutdown: () => void | Promise<void>
  }
  skillMcpManager: {
    disconnectAll: () => Promise<void>
  }
  disposeHooks: () => void
  jevConfig?: JevConfig
  intentRouting?: JevIntentRouting
}): PluginDispose {
  const { backgroundManager, skillMcpManager, disposeHooks } = args
  const intentRouting = args.intentRouting ?? createJevIntentRouting({
    jevConfig: args.jevConfig,
    vocab: JEV_INTENT_ROUTING_VOCABULARY,
  })
  let disposePromise: Promise<void> | null = null

  return async (): Promise<void> => {
    if (disposePromise) {
      await disposePromise
      return
    }

    disposePromise = (async (): Promise<void> => {
      try {
        await backgroundManager.shutdown()
      } catch (error) {
        log("[plugin-dispose] backgroundManager.shutdown() error:", error instanceof Error ? error : String(error))
      }
      try {
        await skillMcpManager.disconnectAll()
      } catch (error) {
        log("[plugin-dispose] skillMcpManager.disconnectAll() error:", error instanceof Error ? error : String(error))
      }
      try {
        disposeHooks()
      } catch (error) {
        log("[plugin-dispose] disposeHooks() error:", error instanceof Error ? error : String(error))
      }
      try {
        await intentRouting.dispose()
      } catch (error) {
        log("[plugin-dispose] intentRouting.dispose() error:", error instanceof Error ? error : String(error))
      }
    })()

    await disposePromise
  }
}
