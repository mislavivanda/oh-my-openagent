import type { JevConfig } from "./config/schema/jev"
import {
  createJevIntentRouting,
  JEV_INTENT_ROUTING_VOCABULARY,
  type JevIntentRouting,
} from "./features/jev"
import { log } from "./shared"

export type PluginDispose = () => Promise<void>

const PLUGIN_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const
type PluginShutdownSignal = (typeof PLUGIN_SHUTDOWN_SIGNALS)[number]

type PluginProcessSignals = Readonly<{
  add(signal: PluginShutdownSignal, listener: () => void): void
  remove(signal: PluginShutdownSignal, listener: () => void): void
  reDeliver(signal: PluginShutdownSignal): void
}>

const DEFAULT_PROCESS_SIGNALS: PluginProcessSignals = {
  add(signal, listener) {
    process.on(signal, listener)
  },
  remove(signal, listener) {
    process.removeListener(signal, listener)
  },
  reDeliver(signal) {
    process.kill(process.pid, signal)
  },
}

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
  processSignals?: PluginProcessSignals
}): PluginDispose {
  const { backgroundManager, skillMcpManager, disposeHooks } = args
  const intentRouting = args.intentRouting ?? createJevIntentRouting({
    jevConfig: args.jevConfig,
    vocab: JEV_INTENT_ROUTING_VOCABULARY,
  })
  const processSignals = args.processSignals ?? DEFAULT_PROCESS_SIGNALS
  let disposePromise: Promise<void> | null = null
  let signalFlushStarted = false
  const signalListeners = new Map<PluginShutdownSignal, () => void>()

  const removeSignalListeners = (): void => {
    for (const [signal, listener] of signalListeners) {
      processSignals.remove(signal, listener)
    }
    signalListeners.clear()
  }

  for (const signal of PLUGIN_SHUTDOWN_SIGNALS) {
    const listener = (): void => {
      if (signalFlushStarted) return
      signalFlushStarted = true
      void intentRouting.dispose().catch((error: unknown) => {
        log("[plugin-dispose] signal intentRouting.dispose() error:", error instanceof Error ? error : String(error))
      }).finally(() => {
        removeSignalListeners()
        try {
          processSignals.reDeliver(signal)
        } catch (error) {
          log("[plugin-dispose] signal re-delivery error:", error instanceof Error ? error : String(error))
        }
      })
    }
    signalListeners.set(signal, listener)
    processSignals.add(signal, listener)
  }

  return async (): Promise<void> => {
    removeSignalListeners()
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
