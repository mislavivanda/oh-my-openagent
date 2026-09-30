import type { PluginInput } from "@opencode-ai/plugin"

import type { BackgroundManager } from "../../features/background-agent"

import type { SessionStateStore } from "./session-state"
import type { MessageWithInfo, SessionState, Todo } from "./types"

export type HandleSessionIdleArgs = {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly sessionStateStore: SessionStateStore
  readonly backgroundManager?: BackgroundManager
  readonly skipAgents?: string[]
  readonly isContinuationStopped?: (sessionID: string) => boolean
}

export type IdleEventContext = {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly sessionStateStore: SessionStateStore
  readonly backgroundManager?: BackgroundManager
  readonly skipAgents: string[]
  readonly isContinuationStopped?: (sessionID: string) => boolean
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
  }
