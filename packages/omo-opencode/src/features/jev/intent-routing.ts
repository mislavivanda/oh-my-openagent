import {
  INTENT_ROUTING_QUESTION_VERSION,
  decideIntentRouting,
  selectDecisionBackend,
  type DecisionBackend,
  type DecisionBackendDeps,
  type IntentRoutingDecisionResult,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { log } from "../../shared/logger"
import { createJevIntentRoutingCapture } from "./intent-routing-capture"
import {
  intentRoutingSessionNotDispatchedReason,
  isJevIntentRoutingSessionEligible,
  safeIntentRoutingBackendKind,
  snapshotIntentRoutingPromptText,
  type IntentRoutingNotDispatchedReason,
  type JevIntentRoutingMessageOutput,
} from "./intent-routing-observation"
import type { IntentRoutingSealCoordinator } from "./intent-routing-seal"
import {
  DEFAULT_INTENT_ROUTING_VOCABULARY,
  intentRoutingVocabularyDigest,
} from "./intent-routing-vocabulary"

export { isJevIntentRoutingSessionEligible } from "./intent-routing-observation"

export type JevIntentRoutingDispatcher = (args: {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}) => Promise<IntentRoutingDecisionResult>

export type JevIntentRouting = {
  readonly enabled: boolean
  readonly inFlight: number
  readonly dispatchesDropped: number
  observe(
    input: { readonly sessionID: unknown },
    output: JevIntentRoutingMessageOutput,
  ): void
  capture(
    input: { readonly tool?: unknown; readonly sessionID?: unknown; readonly callID?: unknown },
    output: { readonly args?: unknown } | null | undefined,
  ): boolean
  sealSessionIdle(sessionID: string): boolean
  deleteSession(sessionID: string): void
  dispose(): Promise<void>
}

export function createJevIntentRouting(args: {
  readonly jevConfig: JevConfig | undefined
  readonly env?: {
    readonly TYPESAFE_API_KEY?: string
    readonly OMO_JEV_BASE_URL?: string
  }
  readonly backend?: DecisionBackend
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly fetch?: DecisionBackendDeps["fetch"]
  readonly logger?: (message: string, data?: unknown) => void
  readonly vocabulary?: IntentRoutingVocabulary
  readonly sealCoordinator?: IntentRoutingSealCoordinator
}): JevIntentRouting {
  const enabled = args.jevConfig?.enabled === true &&
    args.jevConfig.wires.intent_routing.enabled === true
  if (!enabled) {
    return {
      enabled: false,
      inFlight: 0,
      dispatchesDropped: 0,
      observe() {},
      capture: () => false,
      sealSessionIdle: () => false,
      deleteSession() {},
      dispose: async () => {},
    }
  }

  const jevConfig = args.jevConfig
  const wireConfig = jevConfig.wires.intent_routing
  const env = args.env ?? process.env
  const logger = args.logger ?? log
  const safeLog = (message: string, data?: unknown): void => {
    try {
      logger(message, data)
    } catch (error) {
      if (error instanceof Error) return
      void String(error)
    }
  }
  const backendDeps: DecisionBackendDeps = {
    apiKey: env.TYPESAFE_API_KEY,
    ...(env.OMO_JEV_BASE_URL === undefined ? {} : { baseURL: env.OMO_JEV_BASE_URL }),
    ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
  }
  const backend = args.backend ?? selectDecisionBackend({
    enabled: true,
    backend: jevConfig.backend,
    model: jevConfig.model,
    timeoutMs: wireConfig.timeout_ms,
  }, backendDeps)
  const dispatcher = args.dispatcher ?? decideIntentRouting
  const vocabulary = args.vocabulary ?? DEFAULT_INTENT_ROUTING_VOCABULARY
  const vocabularyDigest = intentRoutingVocabularyDigest(vocabulary)
  const sealCoordinator = args.sealCoordinator
  const capture = sealCoordinator === undefined
    ? undefined
    : createJevIntentRoutingCapture({ turnStore: sealCoordinator.store })
  let inFlight = 0
  let dispatchesDropped = 0

  const recordNotDispatched = (
    sessionID: unknown,
    reason: IntentRoutingNotDispatchedReason,
  ): void => safeLog("[jev] intent-routing", {
    wire: "intent_routing",
    sessionID: typeof sessionID === "string" ? sessionID : null,
    backend: safeIntentRoutingBackendKind(backend),
    predictionStatus: "not_dispatched",
    notDispatchedReason: reason,
  })

  const dispatchDecision = async (sessionID: string, promptText: string): Promise<IntentRoutingDecisionResult> => {
    inFlight += 1
    try {
      const result = await dispatcher({
        backend,
        input: { promptText },
        vocab: vocabulary,
        confidenceThreshold: wireConfig.confidence_threshold,
        model: jevConfig.model,
        maxPromptChars: wireConfig.max_prompt_chars,
      })
      safeLog("[jev] intent-routing", {
        wire: "intent_routing",
        questionVersion: result.questionVersion,
        sessionID,
        backend: safeIntentRoutingBackendKind(backend),
        predictionStatus: result.predictionStatus,
        notDispatchedReason: null,
        unavailableReason: result.unavailableReason,
        resolvedModel: result.resolvedModel,
        latencyMs: result.latencyMs,
        answers: result.answers,
        invalidAnswerCount: result.invalidAnswerCount,
        truncatedInput: result.truncatedInput,
      })
      return result
    } catch (error) {
      safeLog("[jev] intent-routing failed", {
        wire: "intent_routing",
        sessionID,
        backend: safeIntentRoutingBackendKind(backend),
        error: String(error).slice(0, 200),
      })
      throw error
    } finally {
      inFlight -= 1
    }
  }

  const runDeferred = (sessionID: unknown, promptText: string): void => {
    const sessionReason = intentRoutingSessionNotDispatchedReason(sessionID)
    if (sessionReason !== null) {
      recordNotDispatched(sessionID, sessionReason)
      return
    }
    if (!isJevIntentRoutingSessionEligible(sessionID)) return
    if (promptText.length === 0) {
      recordNotDispatched(sessionID, "no_user_text")
      return
    }
    if (sealCoordinator === undefined) {
      if (inFlight >= wireConfig.max_inflight) {
        dispatchesDropped += 1
        recordNotDispatched(sessionID, "max_inflight")
        return
      }
      void dispatchDecision(sessionID, promptText).catch(() => undefined)
      return
    }

    const atCapacity = inFlight >= wireConfig.max_inflight
    const turn = sealCoordinator.startTurn({
      sessionID,
      parts: [{ type: "text", text: promptText }],
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
      vocabularyDigest,
      confidenceThreshold: wireConfig.confidence_threshold,
      configuredModelSpec: jevConfig.model,
      dispatch: atCapacity ? undefined : () => dispatchDecision(sessionID, promptText),
      ...(atCapacity ? { notDispatchedReason: "max_inflight" } : {}),
    })
    if (
      atCapacity
      && turn !== null
      && sealCoordinator.store.getTurn(sessionID, turn.turnOrdinal)?.predictionState === "not_dispatched"
    ) {
      dispatchesDropped += 1
      recordNotDispatched(sessionID, "max_inflight")
    }
  }

  return {
    enabled: true,
    get inFlight() { return inFlight },
    get dispatchesDropped() { return dispatchesDropped },
    observe(input, output): void {
      try {
        const sessionID = input.sessionID
        const promptText = snapshotIntentRoutingPromptText(output.parts, wireConfig.max_prompt_chars)
        const handle = setTimeout(() => {
          runDeferred(sessionID, promptText)
        }, 0)
        handle.unref()
      } catch (error) {
        const detail = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
        safeLog("[jev] intent-routing failed", {
          wire: "intent_routing",
          error: detail.slice(0, 200),
        })
      }
    },
    capture: (input, output) => capture?.capture(input, output) ?? false,
    sealSessionIdle: (sessionID) => sealCoordinator?.sealSessionIdle(sessionID) ?? false,
    deleteSession: (sessionID) => sealCoordinator?.deleteSession(sessionID),
    dispose: async () => sealCoordinator?.dispose(),
  }
}
