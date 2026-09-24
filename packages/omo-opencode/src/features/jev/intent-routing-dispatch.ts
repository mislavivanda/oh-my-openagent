import {
  decideIntentRouting,
  INTENT_ROUTING_QUESTION_VERSION,
  selectDecisionBackend,
  type DecisionBackend,
  type DecisionBackendDeps,
  type IntentRoutingDecisionResult,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"

import type { JevConfig } from "../../config/schema/jev"
import { isRealUserTextPart, type InternalInitiatorTextPartLike } from "../../shared"
import { log } from "../../shared/logger"

export type JevIntentRoutingDispatchInput = {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model: string
  readonly maxPromptChars: number
}

export type JevIntentRoutingDispatcher = (
  input: JevIntentRoutingDispatchInput,
) => Promise<IntentRoutingDecisionResult>

export type JevIntentRoutingDispatchEngine = {
  readonly dispatch: (sessionID: string, promptText: string) => Promise<IntentRoutingDecisionResult>
  readonly getStats: () => { readonly inFlight: number; readonly dispatchesDropped: number }
}

export function snapshotJevIntentRoutingPrompt(
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

function failedResult(jevConfig: JevConfig): IntentRoutingDecisionResult {
  return {
    predictionStatus: "failed",
    truncatedInput: false,
    answers: null,
    invalidAnswerCount: 0,
    unavailableReason: "transport_error",
    resolvedModel: null,
    latencyMs: null,
    threshold: jevConfig.wires.intent_routing.confidence_threshold,
    questionVersion: INTENT_ROUTING_QUESTION_VERSION,
  }
}

export function createJevIntentRoutingDispatchEngine(args: {
  readonly jevConfig: JevConfig
  readonly vocab: IntentRoutingVocabulary
  readonly env?: {
    readonly TYPESAFE_API_KEY?: string
    readonly OMO_JEV_BASE_URL?: string
  }
  readonly backend?: DecisionBackend
  readonly backendFetch?: DecisionBackendDeps["fetch"]
  readonly logger?: (message: string, data?: unknown) => void
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly onDispatchDropped?: () => void
}): JevIntentRoutingDispatchEngine {
  const wireConfig = args.jevConfig.wires.intent_routing
  const env = args.env ?? process.env
  const logger = args.logger ?? log
  const backend = args.backend ?? selectDecisionBackend(
    {
      enabled: true,
      backend: args.jevConfig.backend,
      model: args.jevConfig.model,
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

  const safeLog = (message: string, data: unknown): void => {
    try {
      logger(message, data)
    } catch (error) {
      if (error instanceof Error) void error.message
      else void String(error)
    }
  }
  const logFailure = (sessionID: string, error: unknown): void => {
    const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    safeLog("[jev] intent-routing failed", {
      wire: "intent_routing",
      sessionID,
      backend: backend.kind,
      error: errorText.slice(0, 200),
    })
  }

  return {
    dispatch: (sessionID, promptText) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (inFlight >= wireConfig.max_inflight) {
          dispatchesDropped += 1
          args.onDispatchDropped?.()
          resolve(failedResult(args.jevConfig))
          return
        }
        inFlight += 1
        try {
          const pending = dispatcher({
            backend,
            input: { promptText },
            vocab: args.vocab,
            confidenceThreshold: wireConfig.confidence_threshold,
            model: args.jevConfig.model,
            maxPromptChars: wireConfig.max_prompt_chars,
          })
          void pending.then((result) => {
            safeLog("[jev] intent-routing", {
              wire: "intent_routing",
              questionVersion: result.questionVersion,
              sessionID,
              backend: backend.kind,
              predictionStatus: result.predictionStatus,
              unavailableReason: result.unavailableReason,
              answers: result.answers,
              invalidAnswerCount: result.invalidAnswerCount,
              resolvedModel: result.resolvedModel,
              latencyMs: result.latencyMs,
              truncatedInput: result.truncatedInput,
            })
            resolve(result)
          }, (error: unknown) => {
            logFailure(sessionID, error)
            resolve(failedResult(args.jevConfig))
          }).finally(() => {
            inFlight -= 1
          })
        } catch (error) {
          inFlight -= 1
          const failure = error instanceof Error ? error : String(error)
          logFailure(sessionID, failure)
          resolve(failedResult(args.jevConfig))
        }
      }, 0)
      timer.unref()
    }),
    getStats: () => ({ inFlight, dispatchesDropped }),
  }
}
