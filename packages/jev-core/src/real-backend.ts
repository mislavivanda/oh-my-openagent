import {
  TypeSafeClient,
  APITimeoutError,
  APIConnectionError,
  APIError,
  type Fetch,
  type Logger,
} from "@typesafe-ai/sdk"
import { isRecord, validateAnswer, validateAnswers } from "./answer-validation"
import type {
  DecisionBackend,
  DecisionOutcome,
  DecisionRequest,
  DecisionUnavailableReason,
  Questions,
} from "./types"

export type RealDecisionBackendDeps = {
  readonly apiKey: string | undefined
  readonly model: string
  readonly timeoutMs: number
  readonly fetch?: Fetch
  readonly baseURL?: string
  readonly logger?: Logger
}

const SILENT_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function bodyMessage(body: unknown): string {
  return isRecord(body) && typeof body.message === "string"
    ? body.message
    : isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : ""
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactDetail(detail: string, apiKey: string): string {
  return detail.split(apiKey).join("<redacted>").slice(0, 200)
}

export function createRealDecisionBackend(deps: RealDecisionBackendDeps): DecisionBackend {
  let client: TypeSafeClient | undefined

  return {
    kind: "real",
    async decide<Q extends Questions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionOutcome<Q>> {
      const startedAt = performance.now()
      const apiKey = deps.apiKey
      if (!apiKey || apiKey.trim() === "") {
        return {
          status: "unavailable",
          reason: "missing_api_key",
          latencyMs: performance.now() - startedAt,
        }
      }

      const unavailable = (
        reason: DecisionUnavailableReason,
        detail?: string,
      ): DecisionOutcome<Q> => {
        const latencyMs = performance.now() - startedAt
        return detail === undefined
          ? { status: "unavailable", reason, latencyMs }
          : { status: "unavailable", reason, detail: redactDetail(detail, apiKey), latencyMs }
      }

      let activeClient = client
      if (activeClient === undefined) {
        try {
          activeClient = new TypeSafeClient({
            apiKey,
            defaultModel: deps.model,
            timeout: deps.timeoutMs,
            retry: { maxRetries: 0 },
            fetch: deps.fetch,
            baseURL: deps.baseURL,
            logger: deps.logger ?? SILENT_LOGGER,
            logLevel: "error",
          })
          client = activeClient
        } catch (error) {
          return unavailable("transport_error", errorMessage(error))
        }
      }

      let phase: "call" | "validate" = "call"
      try {
        const result: unknown = await activeClient.systemOne({
          state: request.state,
          questions: request.questions,
          model: request.model,
        })
        phase = "validate"

        if (!isRecord(result) || !isRecord(result.answers)) {
          return unavailable("malformed_response", "no answers")
        }
        const answers = result.answers
        if (!validateAnswers(request.questions, answers)) {
          const failingId = Object.keys(request.questions).find(
            (id) => !validateAnswer(request.questions[id], answers[id]),
          )
          return unavailable("malformed_response", failingId ?? "invalid answers")
        }
        if (typeof result.model !== "string") {
          return unavailable("malformed_response", "no model")
        }
        if (!isRecord(result.usage)) {
          return unavailable("malformed_response", "no usage")
        }
        if (
          typeof result.usage.input_tokens !== "number" ||
          !Number.isFinite(result.usage.input_tokens) ||
          typeof result.usage.output_tokens !== "number" ||
          !Number.isFinite(result.usage.output_tokens)
        ) {
          return unavailable("malformed_response", "invalid usage")
        }

        return {
          status: "decided",
          answers,
          model: result.model,
          usage: {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
          },
          latencyMs: performance.now() - startedAt,
        }
      } catch (error) {
        if (error instanceof APITimeoutError) {
          return unavailable("timeout", error.message)
        }
        if (error instanceof APIConnectionError) {
          return unavailable("transport_error", error.message)
        }
        if (error instanceof APIError) {
          return unavailable(
            "api_error",
            `status ${error.status}: ${bodyMessage(error.body).slice(0, 120)}`,
          )
        }
        return unavailable(
          phase === "validate" ? "malformed_response" : "transport_error",
          errorMessage(error),
        )
      }
    },
  }
}
