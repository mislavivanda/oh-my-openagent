import type { PluginInput } from "@opencode-ai/plugin"

import type { BackgroundManager } from "../../features/background-agent"

import type { CompletionContinuationObserver } from "./completion-continuation-observer"
import type { SessionStateStore } from "./session-state"
import type { MessageWithInfo, SessionState, Todo } from "./types"

export type IdleEventLogger = (message: string, data?: unknown) => void

export type HandleSessionIdleArgs = {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly sessionStateStore: SessionStateStore
  readonly backgroundManager?: BackgroundManager
  readonly skipAgents?: string[]
  readonly isContinuationStopped?: (sessionID: string) => boolean
  readonly completionContinuationObserver?: CompletionContinuationObserver
  readonly logger?: IdleEventLogger
}

export type IdleEventContext = {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly sessionStateStore: SessionStateStore
  readonly backgroundManager?: BackgroundManager
  readonly skipAgents: string[]
  readonly isContinuationStopped?: (sessionID: string) => boolean
  readonly completionContinuationObserver: CompletionContinuationObserver
  readonly logger: IdleEventLogger
}

export type IdleEventPreflightResult =
  | { readonly kind: "stop" }
  | {
    readonly kind: "continue"
    readonly state: SessionState
    readonly observedCompactionEpoch: number | undefined
    readonly prefetchedMessages: MessageWithInfo[]
    readonly todos: Todo[]
    readonly incompleteCount: number
    readonly promiseComplete: boolean
  }
