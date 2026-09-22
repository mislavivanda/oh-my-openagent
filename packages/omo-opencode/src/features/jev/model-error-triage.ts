import {
  decideModelErrorTriage,
  selectDecisionBackend,
  type DecisionBackend,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { shouldRetryError, type ErrorInfo } from "../../shared/model-error-classifier"
import { log } from "../../shared/logger"

export type JevModelErrorTriageSite =
  | "message.updated"
  | "session.status"
  | "session.error"

export type JevModelErrorTriage = {
  readonly enabled: boolean
  shouldRetry(
    errorInfo: ErrorInfo,
    context: {
      readonly site: JevModelErrorTriageSite
      readonly sessionID: string
    },
  ): Promise<boolean>
}

function safeKind(backend: DecisionBackend): string {
  try {
    return backend.kind
  } catch {
    return "unknown"
  }
}

export function createJevModelErrorTriage(args: {
  readonly jevConfig: JevConfig | undefined
  readonly env?: { readonly TYPESAFE_API_KEY?: string }
  readonly backend?: DecisionBackend
  readonly heuristic?: (info: ErrorInfo) => boolean
  readonly logger?: (message: string, data?: unknown) => void
}): JevModelErrorTriage {
  const heuristic = args.heuristic ?? shouldRetryError
  const enabled =
    args.jevConfig?.enabled === true &&
    args.jevConfig.wires.model_error_triage.enabled === true

  if (!enabled) {
    return {
      enabled: false,
      shouldRetry: async (info) => heuristic(info),
    }
  }

  const jevConfig = args.jevConfig
  const env = args.env ?? process.env
  const logger = args.logger ?? log
  const safeLog = (message: string, data?: unknown): void => {
    try {
      logger(message, data)
    } catch (error) {
      void error
    }
  }
  const backend =
    args.backend ??
    selectDecisionBackend(
      {
        enabled: true,
        backend: jevConfig.backend,
        model: jevConfig.model,
        timeoutMs: jevConfig.timeout_ms,
      },
      { apiKey: env.TYPESAFE_API_KEY },
    )

  return {
    enabled: true,
    async shouldRetry(info, context) {
      const heuristicShouldRetry = heuristic(info)

      try {
        const result = await decideModelErrorTriage({
          backend,
          input: info,
          heuristic: () => heuristicShouldRetry,
          confidenceThreshold:
            jevConfig.wires.model_error_triage.confidence_threshold,
          model: jevConfig.model,
        })
        safeLog("[jev] model-error-triage", {
          wire: "model_error_triage",
          questionVersion: result.questionVersion,
          site: context.site,
          sessionID: context.sessionID,
          backend: backend.kind,
          status: result.source === "jev" ? "applied" : "fell_through",
          reason: result.fellThroughReason ?? null,
          choice: result.jev?.choice ?? null,
          confidence: result.jev?.confidence ?? null,
          probabilities: result.jev?.probabilities ?? null,
          threshold: result.threshold,
          model: result.jev?.model ?? null,
          latencyMs: result.jev?.latencyMs ?? null,
          heuristicShouldRetry: result.heuristicShouldRetry,
          shouldRetry: result.shouldRetry,
          errorName: info.name ?? null,
          errorMessageHead: (info.message ?? "").slice(0, 200),
        })
        return result.shouldRetry
      } catch (error) {
        safeLog("[jev] model-error-triage failed; using heuristic", {
          wire: "model_error_triage",
          site: context.site,
          sessionID: context.sessionID,
          backend: safeKind(backend),
          error: String(error).slice(0, 200),
        })
        return heuristicShouldRetry
      }
    },
  }
}
