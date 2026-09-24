// allow: SIZE_OK - One shared instance owns dispatch, capture, seal, and disposal identity.

import {
  INTENT_ROUTING_QUESTION_VERSION,
  type DecisionBackend,
  type DecisionBackendDeps,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"

import type { JevConfig } from "../../config/schema/jev"
import type { InternalInitiatorTextPartLike } from "../../shared"
import { log } from "../../shared/logger"
import { getMainSessionID, subagentSessions } from "../claude-code-session-state"
import {
  captureIntentRoutingDelegationAttempt,
} from "./intent-routing-capture"
import {
  createJevIntentRoutingDispatchEngine,
  snapshotJevIntentRoutingPrompt,
  type JevIntentRoutingDispatcher,
} from "./intent-routing-dispatch"
import {
  getJevIntentRoutingSessionGateReason,
} from "./intent-routing-session-gate"
import {
  createIntentRoutingSealController,
  type IntentRoutingSealController,
} from "./intent-routing-seal"
import {
  createIntentRoutingSink,
  type IntentRoutingSink,
} from "./intent-routing-sink"
import { createJevIntentRoutingVocabularyDigest } from "./intent-routing-vocabulary"

export type JevIntentRoutingNotDispatchedReason =
  | "disabled"
  | "main_session_unknown"
  | "subagent_session"
  | "non_main_session"
  | "max_inflight"
  | "dispatch_error"

export type JevIntentRoutingReceipt = {
  readonly predictionStatus: "pending" | "not_dispatched"
  readonly notDispatchedReason: JevIntentRoutingNotDispatchedReason | null
}

type JevIntentRoutingToolInput = {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
}

export type JevIntentRouting = {
  readonly enabled: boolean
  readonly observe: (
    input: { readonly sessionID: string },
    output: { readonly parts: readonly InternalInitiatorTextPartLike[] },
  ) => JevIntentRoutingReceipt
  readonly capture: (
    input: JevIntentRoutingToolInput,
    output: { readonly args: Readonly<Record<string, unknown>> },
  ) => void
  readonly onSessionIdle: (sessionID: string) => boolean
  readonly onSessionDeleted: (sessionID: string) => void
  readonly dispose: () => Promise<void>
  readonly getStats: () => { readonly inFlight: number; readonly dispatchesDropped: number }
}

function notDispatched(
  reason: JevIntentRoutingNotDispatchedReason,
): JevIntentRoutingReceipt {
  return { predictionStatus: "not_dispatched", notDispatchedReason: reason }
}

function disabledIntentRouting(): JevIntentRouting {
  return {
    enabled: false,
    observe: () => notDispatched("disabled"),
    capture: () => undefined,
    onSessionIdle: () => false,
    onSessionDeleted: () => undefined,
    dispose: async () => undefined,
    getStats: () => ({ inFlight: 0, dispatchesDropped: 0 }),
  }
}

export function createJevIntentRouting(args: {
  readonly jevConfig: JevConfig | undefined
  readonly vocab: IntentRoutingVocabulary
  readonly env?: {
    readonly TYPESAFE_API_KEY?: string
    readonly OMO_JEV_BASE_URL?: string
  }
  readonly backend?: DecisionBackend
  readonly backendFetch?: DecisionBackendDeps["fetch"]
  readonly logger?: (message: string, data?: unknown) => void
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly sink?: IntentRoutingSink
  readonly sealController?: IntentRoutingSealController
}): JevIntentRouting {
  const enabled = args.jevConfig?.enabled === true
    && args.jevConfig.wires.intent_routing.enabled === true
  if (!enabled) return disabledIntentRouting()

  const jevConfig = args.jevConfig
  const wireConfig = jevConfig.wires.intent_routing
  const controller = args.sealController ?? createIntentRoutingSealController({
    sink: args.sink ?? createIntentRoutingSink(),
    turnSealTimeoutMs: wireConfig.turn_seal_timeout_ms,
    maxPromptChars: wireConfig.max_prompt_chars,
    storeOptions: { predictionTimeoutMs: wireConfig.timeout_ms },
  })
  const dispatchEngine = createJevIntentRoutingDispatchEngine({
    jevConfig,
    vocab: args.vocab,
    env: args.env,
    backend: args.backend,
    backendFetch: args.backendFetch,
    logger: args.logger,
    dispatcher: args.dispatcher,
    onDispatchDropped: controller.recordDispatchDropped,
  })
  const vocabularyDigest = createJevIntentRoutingVocabularyDigest(args.vocab)
  const logger = args.logger ?? log
  const logLifecycleFailure = (
    sessionID: string,
    stage: "observe" | "capture" | "session_idle" | "session_deleted",
    error: unknown,
  ): void => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try {
      logger("[jev] intent-routing failed", {
        wire: "intent_routing",
        sessionID,
        stage,
        error: detail.slice(0, 200),
      })
    } catch (loggingError) {
      if (loggingError instanceof Error) void loggingError.message
      else void String(loggingError)
    }
  }

  return {
    enabled: true,
    observe: (input, output) => {
      try {
        const gateReason = getJevIntentRoutingSessionGateReason(input.sessionID)
        const shared = {
          sessionID: input.sessionID,
          parts: output.parts,
          questionVersion: INTENT_ROUTING_QUESTION_VERSION,
          vocabularyDigest,
          confidenceThreshold: wireConfig.confidence_threshold,
          configuredModelSpec: jevConfig.model,
        }
        if (gateReason !== null) {
          controller.onMessage({ ...shared, notDispatchedReason: gateReason })
          return notDispatched(gateReason)
        }
        const promptText = snapshotJevIntentRoutingPrompt(
          output.parts,
          wireConfig.max_prompt_chars,
        )
        controller.onMessage({
          ...shared,
          dispatch: () => dispatchEngine.dispatch(input.sessionID, promptText),
        })
        return { predictionStatus: "pending", notDispatchedReason: null }
      } catch (error) {
        const failure = error instanceof Error ? error : String(error)
        logLifecycleFailure(input.sessionID, "observe", failure)
        return notDispatched("dispatch_error")
      }
    },
    capture: (input, output) => {
      try {
        const observation = captureIntentRoutingDelegationAttempt({
          input,
          output,
          mainSessionID: getMainSessionID(),
          isSubagentSession: subagentSessions.has(input.sessionID),
          offeredCategories: args.vocab.categories,
        })
        if (observation !== null) {
          controller.appendObservation({ sessionID: input.sessionID, observation })
        }
      } catch (error) {
        const failure = error instanceof Error ? error : String(error)
        logLifecycleFailure(input.sessionID, "capture", failure)
      }
    },
    onSessionIdle: (sessionID) => {
      try {
        return controller.onSessionIdle(sessionID)
      } catch (error) {
        const failure = error instanceof Error ? error : String(error)
        logLifecycleFailure(sessionID, "session_idle", failure)
        return false
      }
    },
    onSessionDeleted: (sessionID) => {
      try {
        controller.onSessionDeleted(sessionID)
      } catch (error) {
        const failure = error instanceof Error ? error : String(error)
        logLifecycleFailure(sessionID, "session_deleted", failure)
      }
    },
    dispose: controller.dispose,
    getStats: dispatchEngine.getStats,
  }
}

export {
  getJevIntentRoutingSessionGateReason,
  isJevIntentRoutingSessionEligible,
} from "./intent-routing-session-gate"
export type { JevIntentRoutingDispatcher } from "./intent-routing-dispatch"
