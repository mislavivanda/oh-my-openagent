import { INTENT_ROUTING_QUESTION_VERSION } from "@oh-my-opencode/jev-core"
import type { DecisionBackend, IntentRoutingDecisionResult } from "@oh-my-opencode/jev-core"
import type { JevIntentRoutingWireConfig } from "../../config/schema/jev"
import { isRealUserTextPart } from "../../shared"
import type { JevIntentRoutingRuntime } from "./intent-routing-runtime"
import {
  getJevIntentRoutingSessionGateReason,
  isJevIntentRoutingSessionEligible,
} from "./intent-routing-session-gate"
import type { JevIntentRoutingNotDispatchedReason } from "./intent-routing-session-gate"

export type JevIntentRoutingDispatchRequest = Readonly<{
  sessionID: string
  promptText: string
  truncatedInput: boolean
}>

export type JevIntentRoutingDispatcher = (
  request: JevIntentRoutingDispatchRequest,
) => Promise<IntentRoutingDecisionResult>

export type IntentRoutingTextPart = Readonly<{
  type?: string
  text?: string
  synthetic?: boolean
}>

type PromptSnapshot = Readonly<{ promptText: string; truncatedInput: boolean }>

function snapshotPromptText(
  parts: readonly IntentRoutingTextPart[],
  maxPromptChars: number,
): PromptSnapshot {
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

function safeBackendKind(backend: DecisionBackend): string {
  try {
    return backend.kind
  } catch (error) {
    if (error instanceof Error) return "unknown"
    return "unknown"
  }
}

export function createJevIntentRoutingDispatch(args: Readonly<{
  backend: DecisionBackend
  dispatcher: JevIntentRoutingDispatcher
  logger: (message: string, data?: unknown) => void
  runtime: JevIntentRoutingRuntime
  wireConfig: JevIntentRoutingWireConfig
}>): Readonly<{
  readonly inFlight: number
  readonly dispatchesDropped: number
  dispatch(
    input: { readonly sessionID: string },
    output: { readonly parts: readonly IntentRoutingTextPart[] },
  ): void
}> {
  let inFlight = 0
  let dispatchesDropped = 0

  const safeLog = (message: string, data?: unknown): void => {
    try {
      args.logger(message, data)
    } catch (error) {
      if (error instanceof Error) return
    }
  }
  const logNotDispatched = (
    request: JevIntentRoutingDispatchRequest,
    reason: JevIntentRoutingNotDispatchedReason,
  ): void => {
    safeLog("[jev] intent-routing", {
      wire: "intent_routing",
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
      sessionID: request.sessionID,
      backend: safeBackendKind(args.backend),
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
      backend: safeBackendKind(args.backend),
      error: String(error).slice(0, 200),
    })
  }
  const handleResult = (sessionID: string, result: IntentRoutingDecisionResult): IntentRoutingDecisionResult => {
    safeLog("[jev] intent-routing", {
      wire: "intent_routing",
      questionVersion: result.questionVersion,
      sessionID,
      backend: safeBackendKind(args.backend),
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
    return result
  }

  return {
    get inFlight() { return inFlight },
    get dispatchesDropped() { return dispatchesDropped },
    dispatch(input, output) {
      const sessionID = input.sessionID
      const snapshot = snapshotPromptText(output.parts, args.wireConfig.max_prompt_chars)
      const timer = setTimeout(() => {
        try {
          const gateReason = getJevIntentRoutingSessionGateReason(sessionID)
          if (!isJevIntentRoutingSessionEligible(sessionID)) {
            const reason = gateReason ?? "non_main_session"
            logNotDispatched({ sessionID, ...snapshot }, reason)
            args.runtime.handleMessage({
              sessionID,
              parts: [{ type: "text", text: snapshot.promptText }],
              truncatedInput: snapshot.truncatedInput,
              notDispatchedReason: reason,
            })
            return
          }
          if (inFlight >= args.wireConfig.max_inflight) {
            dispatchesDropped += 1
            logNotDispatched({ sessionID, ...snapshot }, "max_inflight")
            args.runtime.handleMessage({
              sessionID,
              parts: [{ type: "text", text: snapshot.promptText }],
              truncatedInput: snapshot.truncatedInput,
              notDispatchedReason: "max_inflight",
            })
            return
          }

          const request = Object.freeze({ sessionID, ...snapshot })
          args.runtime.handleMessage({
            sessionID,
            parts: [{ type: "text", text: snapshot.promptText }],
            truncatedInput: snapshot.truncatedInput,
            dispatch: () => {
              inFlight += 1
              let pending: Promise<IntentRoutingDecisionResult>
              try {
                pending = args.dispatcher(request)
              } catch (error) {
                const rejection = error instanceof Error ? error : new Error(String(error))
                inFlight -= 1
                logFailure(sessionID, rejection)
                return Promise.reject(rejection)
              }
              return pending.then(
                (result) => handleResult(sessionID, result),
                (error: unknown) => {
                  logFailure(sessionID, error)
                  throw error
                },
              ).finally(() => { inFlight -= 1 })
            },
          })
        } catch (error) {
          logFailure(sessionID, error instanceof Error ? error : String(error))
        }
      }, 0)
      timer.unref()
    },
  }
}
