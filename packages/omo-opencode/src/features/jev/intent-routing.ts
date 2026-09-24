import { INTENT_ROUTING_QUESTION_VERSION, decideIntentRouting, selectDecisionBackend } from "@oh-my-opencode/jev-core"
import type {
  DecisionBackend,
  DecisionBackendDeps,
  IntentRoutingDecisionResult,
  IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { isRealUserTextPart, log } from "../../shared"
import { getMainSessionID, subagentSessions } from "../claude-code-session-state/state"

export type JevIntentRoutingNotDispatchedReason = "main_session_unknown" | "non_main_session" | "subagent_session" | "max_inflight"

export type JevIntentRoutingDispatchRequest = Readonly<{
  sessionID: string
  promptText: string
  truncatedInput: boolean
}>

export type JevIntentRoutingDispatcher = (request: JevIntentRoutingDispatchRequest) => Promise<IntentRoutingDecisionResult>

type IntentRoutingTextPart = Readonly<{ type?: string; text?: string; synthetic?: boolean }>

export type JevIntentRouting = {
  readonly enabled: boolean
  readonly inFlight: number
  readonly dispatchesDropped: number
  dispatch(
    input: { readonly sessionID: string },
    output: { readonly parts: readonly IntentRoutingTextPart[] },
  ): void
}

type PromptSnapshot = Readonly<{ promptText: string; truncatedInput: boolean }>

function sessionGateReason(sessionID: string): JevIntentRoutingNotDispatchedReason | null {
  const mainSessionID = getMainSessionID()
  if (mainSessionID === undefined) return "main_session_unknown"
  if (subagentSessions.has(sessionID)) return "subagent_session"
  if (sessionID !== mainSessionID) return "non_main_session"
  return null
}

export function isJevIntentRoutingSessionEligible(sessionID: string): boolean {
  return sessionGateReason(sessionID) === null
}

function snapshotPromptText(parts: readonly IntentRoutingTextPart[], maxPromptChars: number): PromptSnapshot {
  let promptText = ""
  let truncatedInput = false

  for (const part of parts) {
    if (!isRealUserTextPart(part)) continue
    const separator = promptText.length === 0 ? "" : "\n"
    const remaining = maxPromptChars - promptText.length
    if (remaining <= separator.length) {
      truncatedInput = true
      break
    }
    promptText += separator
    const textRemaining = maxPromptChars - promptText.length
    promptText += part.text.slice(0, textRemaining)
    if (part.text.length > textRemaining) {
      truncatedInput = true
      break
    }
  }

  return Object.freeze({ promptText, truncatedInput })
}

function safeKind(backend: DecisionBackend): string {
  try { return backend.kind }
  catch { return "unknown" }
}

export function createJevIntentRouting(args: {
  readonly jevConfig: JevConfig | undefined
  readonly vocab: IntentRoutingVocabulary
  readonly env?: { readonly TYPESAFE_API_KEY?: string; readonly OMO_JEV_BASE_URL?: string }
  readonly backend?: DecisionBackend
  readonly fetch?: DecisionBackendDeps["fetch"]
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly logger?: (message: string, data?: unknown) => void
}): JevIntentRouting {
  const enabled =
    args.jevConfig?.enabled === true && args.jevConfig.wires.intent_routing.enabled === true

  if (!enabled) {
    return { enabled: false, inFlight: 0, dispatchesDropped: 0, dispatch() {} }
  }

  const jevConfig = args.jevConfig
  const wireConfig = jevConfig.wires.intent_routing
  const env = args.env ?? process.env
  const logger = args.logger ?? log
  const safeLog = (message: string, data?: unknown): void => {
    try {
      logger(message, data)
    } catch (error) {
      void error
    }
  }
  const backendDeps = {
    apiKey: env.TYPESAFE_API_KEY,
    ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    ...(env.OMO_JEV_BASE_URL === undefined ? {} : { baseURL: env.OMO_JEV_BASE_URL }),
  } satisfies DecisionBackendDeps
  const backend =
    args.backend ??
    selectDecisionBackend(
      { enabled: true, backend: jevConfig.backend, model: jevConfig.model, timeoutMs: wireConfig.timeout_ms },
      backendDeps,
    )
  const dispatcher =
    args.dispatcher ??
    (async (request: JevIntentRoutingDispatchRequest) => {
      const result = await decideIntentRouting({
        backend,
        input: { promptText: request.promptText },
        vocab: args.vocab,
        confidenceThreshold: wireConfig.confidence_threshold,
        model: jevConfig.model,
        maxPromptChars: wireConfig.max_prompt_chars,
      })
      return request.truncatedInput && !result.truncatedInput
        ? { ...result, truncatedInput: true }
        : result
    })

  let inFlight = 0
  let dispatchesDropped = 0

  const logNotDispatched = (
    request: JevIntentRoutingDispatchRequest,
    reason: JevIntentRoutingNotDispatchedReason,
  ): void => {
    safeLog("[jev] intent-routing", {
      wire: "intent_routing",
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
      sessionID: request.sessionID,
      backend: safeKind(backend),
      predictionStatus: "not_dispatched",
      notDispatchedReason: reason,
      unavailableReason: null,
      resolvedModel: null,
      latencyMs: 0,
      truncatedInput: request.truncatedInput,
      answers: null,
      labels: null,
      invalidAnswerCount: 0,
    })
  }

  const logFailure = (sessionID: string, error: unknown): void => {
    safeLog("[jev] intent-routing failed", {
      wire: "intent_routing",
      sessionID,
      backend: safeKind(backend),
      error: String(error).slice(0, 200),
    })
  }

  return {
    enabled: true,
    get inFlight() { return inFlight },
    get dispatchesDropped() { return dispatchesDropped },
    dispatch(input, output) {
      const sessionID = input.sessionID
      const snapshot = snapshotPromptText(output.parts, wireConfig.max_prompt_chars)
      const timer = setTimeout(() => {
        let reserved = false
        try {
          if (!isJevIntentRoutingSessionEligible(sessionID)) {
            const reason = sessionGateReason(sessionID) ?? "non_main_session"
            logNotDispatched({ sessionID, ...snapshot }, reason)
            return
          }
          if (inFlight >= wireConfig.max_inflight) {
            dispatchesDropped += 1
            logNotDispatched({ sessionID, ...snapshot }, "max_inflight")
            return
          }

          inFlight += 1
          reserved = true
          const request = Object.freeze({ sessionID, ...snapshot })
          const pending = dispatcher(request)
          void pending
            .then((result) => {
              safeLog("[jev] intent-routing", {
                wire: "intent_routing",
                questionVersion: result.questionVersion,
                sessionID,
                backend: safeKind(backend),
                predictionStatus: result.predictionStatus,
                notDispatchedReason: null,
                unavailableReason: result.unavailableReason,
                resolvedModel: result.resolvedModel,
                latencyMs: result.latencyMs,
                truncatedInput: result.truncatedInput,
                answers: result.answers,
                labels: result.labels,
                invalidAnswerCount: result.invalidAnswerCount,
              })
            })
            .catch((error: unknown) => logFailure(sessionID, error))
            .finally(() => { inFlight -= 1 })
        } catch (error) {
          if (reserved) inFlight -= 1
          logFailure(sessionID, error)
        }
      }, 0)
      timer.unref()
    },
  }
}
