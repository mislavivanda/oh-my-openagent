import { log } from "./shared"
import type { OhMyOpenCodeConfig } from "./config"
import {
  createPluginJevIntentRouting,
  type JevIntentRouting,
} from "./features/jev"

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
  const intentRouting = args.intentRouting ?? createPluginJevIntentRouting(args.pluginConfig)
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
        const detail = error instanceof Error ? error : String(error)
        log("[plugin-dispose] backgroundManager.shutdown() error:", detail)
      }
      try {
        await skillMcpManager.disconnectAll()
      } catch (error) {
        const detail = error instanceof Error ? error : String(error)
        log("[plugin-dispose] skillMcpManager.disconnectAll() error:", detail)
      }
      try {
        disposeHooks()
      } catch (error) {
        const detail = error instanceof Error ? error : String(error)
        log("[plugin-dispose] disposeHooks() error:", detail)
      }
      try {
        await intentRouting.dispose()
      } catch (error) {
        const detail = error instanceof Error ? error : String(error)
        log("[plugin-dispose] intentRouting.dispose() error:", detail)
      }
    })()

    await disposePromise
  }
}
