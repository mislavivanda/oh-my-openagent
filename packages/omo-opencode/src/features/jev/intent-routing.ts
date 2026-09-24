import { decideIntentRouting, selectDecisionBackend, type DecisionBackend, type DecisionBackendDeps } from "@oh-my-opencode/jev-core"
import type { IntentRoutingDecisionResult, IntentRoutingVocabulary } from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { isRealUserTextPart, type InternalInitiatorTextPartLike } from "../../shared"
import { log } from "../../shared/logger"
import { getMainSessionID, subagentSessions } from "../claude-code-session-state"

export type JevIntentRoutingNotDispatchedReason = "disabled" | "main_session_unknown" | "subagent_session" | "non_main_session" | "max_inflight" | "dispatch_error"

export type JevIntentRoutingDispatchInput = {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model: string
  readonly maxPromptChars: number
}

export type JevIntentRoutingDispatcher = (input: JevIntentRoutingDispatchInput) => Promise<IntentRoutingDecisionResult>

export type JevIntentRoutingReceipt = {
  readonly predictionStatus: "pending" | "not_dispatched"
  readonly notDispatchedReason: JevIntentRoutingNotDispatchedReason | null
}

export type JevIntentRouting = {
  readonly enabled: boolean
  observe(
    input: { readonly sessionID: string },
    output: {
      readonly parts: readonly InternalInitiatorTextPartLike[]
    },
  ): JevIntentRoutingReceipt
  getStats(): { readonly inFlight: number; readonly dispatchesDropped: number }
}

function safeKind(backend: DecisionBackend): string {
  try {
    return backend.kind
  } catch {
    return "unknown"
  }
}

function notDispatched(
  reason: JevIntentRoutingNotDispatchedReason,
): JevIntentRoutingReceipt {
  return { predictionStatus: "not_dispatched", notDispatchedReason: reason }
}

function snapshotPromptText(
  parts: readonly InternalInitiatorTextPartLike[],
  maxPromptChars: number,
): string {
  const chunks: string[] = []
  let copiedChars = 0
  for (const part of parts) {
    if (copiedChars >= maxPromptChars) break
    if (!isRealUserTextPart(part)) continue
    const separator = chunks.length === 0 ? "" : "\n"
    const chunk = `${separator}${part.text}`.slice(0, maxPromptChars - copiedChars)
    chunks.push(chunk)
    copiedChars += chunk.length
  }
  return chunks.join("")
}

export function getJevIntentRoutingSessionGateReason(
  sessionID: string,
): JevIntentRoutingNotDispatchedReason | null {
  if (subagentSessions.has(sessionID)) return "subagent_session"
  const mainSessionID = getMainSessionID()
  if (mainSessionID === undefined) return "main_session_unknown"
  return sessionID === mainSessionID ? null : "non_main_session"
}

export function isJevIntentRoutingSessionEligible(sessionID: string): boolean {
  return getJevIntentRoutingSessionGateReason(sessionID) === null
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
}): JevIntentRouting {
  const enabled =
    args.jevConfig?.enabled === true &&
    args.jevConfig.wires.intent_routing.enabled === true

  if (!enabled) {
    return {
      enabled: false,
      observe: () => notDispatched("disabled"),
      getStats: () => ({ inFlight: 0, dispatchesDropped: 0 }),
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
      if (error instanceof Error) void error.message
    }
  }
  const backend =
    args.backend ??
    selectDecisionBackend(
      {
        enabled: true,
        backend: jevConfig.backend,
        model: jevConfig.model,
        timeoutMs: wireConfig.timeout_ms,
      },
      {
        apiKey: env.TYPESAFE_API_KEY,
        fetch: args.backendFetch,
        baseURL: env.OMO_JEV_BASE_URL,
      },
    )
  const dispatcher = args.dispatcher ?? decideIntentRouting
  let inFlight = 0
  let dispatchesDropped = 0
  const logFailure = (sessionID: string, error: unknown): void => {
    const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    safeLog("[jev] intent-routing failed", {
      wire: "intent_routing",
      sessionID,
      backend: safeKind(backend),
      error: errorText.slice(0, 200),
    })
  }

  return {
    enabled: true,
    observe(input, output) {
      try {
        const gateReason = getJevIntentRoutingSessionGateReason(input.sessionID)
        if (gateReason !== null) return notDispatched(gateReason)
        const sessionID = input.sessionID
        const promptText = snapshotPromptText(output.parts, wireConfig.max_prompt_chars)
        const timer = setTimeout(() => {
          let reserved = false
          try {
            if (inFlight >= wireConfig.max_inflight) {
              dispatchesDropped += 1
              return
            }
            inFlight += 1
            reserved = true
            const pending = dispatcher({
              backend,
              input: { promptText },
              vocab: args.vocab,
              confidenceThreshold: wireConfig.confidence_threshold,
              model: jevConfig.model,
              maxPromptChars: wireConfig.max_prompt_chars,
            })
            void pending
              .then((result) => {
                safeLog("[jev] intent-routing", {
                  wire: "intent_routing",
                  questionVersion: result.questionVersion,
                  sessionID,
                  backend: safeKind(backend),
                  predictionStatus: result.predictionStatus,
                  unavailableReason: result.unavailableReason,
                  answers: result.answers,
                  invalidAnswerCount: result.invalidAnswerCount,
                  resolvedModel: result.resolvedModel,
                  latencyMs: result.latencyMs,
                  truncatedInput: result.truncatedInput,
                })
              })
              .catch((error: unknown) => {
                logFailure(sessionID, error)
              })
              .finally(() => {
                inFlight -= 1
              })
          } catch (error) {
            if (reserved) inFlight -= 1
            logFailure(sessionID, error instanceof Error ? error : String(error))
          }
        }, 0)
        timer.unref()
        return { predictionStatus: "pending", notDispatchedReason: null }
      } catch (error) {
        logFailure(input.sessionID, error instanceof Error ? error : String(error))
        return notDispatched("dispatch_error")
      }
    },
    getStats: () => ({ inFlight, dispatchesDropped }),
  }
}
