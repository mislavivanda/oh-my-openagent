import { log } from "./shared"
import type { OhMyOpenCodeConfig } from "./config"
import { createJevIntentRouting, type JevIntentRouting } from "./features/jev"

export type PluginDispose = () => Promise<void>

export function createPluginDispose(args: {
  backgroundManager: {
    shutdown: () => void | Promise<void>
  }
  skillMcpManager: {
    disconnectAll: () => Promise<void>
  }
  disposeHooks: () => void
  pluginConfig?: OhMyOpenCodeConfig
  intentRouting?: JevIntentRouting
}): PluginDispose {
  const { backgroundManager, skillMcpManager, disposeHooks } = args
  const intentRouting = args.intentRouting ?? createJevIntentRouting({ jevConfig: args.pluginConfig?.jev })
  let disposePromise: Promise<void> | null = null

  return async (): Promise<void> => {
    if (disposePromise) {
      await disposePromise
      return
    }

    disposePromise = (async (): Promise<void> => {
      try {
        await intentRouting.dispose()
      } catch (error) {
        log("[plugin-dispose] intentRouting.dispose() error:", error)
      }
      try {
        await backgroundManager.shutdown()
      } catch (error) {
        log("[plugin-dispose] backgroundManager.shutdown() error:", error)
      }
      try {
        await skillMcpManager.disconnectAll()
      } catch (error) {
        log("[plugin-dispose] skillMcpManager.disconnectAll() error:", error)
      }
      try {
        disposeHooks()
      } catch (error) {
        log("[plugin-dispose] disposeHooks() error:", error)
      }
    })()

    await disposePromise
  }
}
