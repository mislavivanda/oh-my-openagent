import type { DecisionBackend, DecisionUnavailableReason, Questions } from "./types"

export const MODEL_ERROR_TRIAGE_QUESTION_VERSION = 1

export type ModelErrorTriageChoice = "retry" | "stop" | "ignore"

export const MODEL_ERROR_TRIAGE_QUESTIONS = {
  triage: {
    type: "choice",
    instructions:
      "An AI coding harness sent a request to an LLM provider and the provider returned the error described in the state. Decide how the harness should respond to this error.",
    criteria: {
      retry:
        "The failure is transient or specific to this provider or model, so retrying on a different model or provider is likely to succeed: rate limiting, overloaded or temporarily unavailable service, gateway or server errors, connection or network failures, model not found or not supported by this provider, provider cooling down or asking to try again later.",
      stop:
        "The account or plan itself is exhausted, so switching models or providers will not help: quota exceeded, billing or payment required, credits or balance exhausted, monthly, daily, or plan usage limit reached, free usage limit reached.",
      ignore:
        "The error is not the provider's fault or must be handled without switching models: the request was aborted by the user, permission denied, the harness sent an invalid or malformed request, the context length was exceeded, a local validation or syntax error, or an error unrelated to model availability.",
    },
  },
} as const satisfies Questions

export type ModelErrorTriageInput = {
  readonly name?: string
  readonly message?: string
  readonly statusCode?: number
}

export const MODEL_ERROR_MESSAGE_MAX_CHARS = 2000

export function buildModelErrorTriageState(input: ModelErrorTriageInput): {
  error_name: string | null
  error_message: string | null
  status_code: number | null
} {
  return {
    error_name: input.name ?? null,
    error_message: input.message?.slice(0, MODEL_ERROR_MESSAGE_MAX_CHARS) ?? null,
    status_code: input.statusCode ?? null,
  }
}

export type ModelErrorTriageResult = {
  readonly shouldRetry: boolean
  readonly source: "jev" | "heuristic"
  readonly heuristicShouldRetry: boolean
  readonly jev?: {
    readonly choice: ModelErrorTriageChoice
    readonly confidence: number
    readonly probabilities: Readonly<Record<ModelErrorTriageChoice, number>>
    readonly model: string
    readonly latencyMs: number
  }
  readonly fellThroughReason?: DecisionUnavailableReason | "low_confidence"
  readonly threshold: number
  readonly questionVersion: number
}

export async function decideModelErrorTriage(args: {
  readonly backend: DecisionBackend
  readonly input: ModelErrorTriageInput
  readonly heuristic: (input: ModelErrorTriageInput) => boolean
  readonly confidenceThreshold: number
  readonly model?: string
}): Promise<ModelErrorTriageResult> {
  const heuristicShouldRetry = args.heuristic(args.input)
  const heuristicResult = {
    shouldRetry: heuristicShouldRetry,
    source: "heuristic",
    heuristicShouldRetry,
    threshold: args.confidenceThreshold,
    questionVersion: MODEL_ERROR_TRIAGE_QUESTION_VERSION,
  } as const

  if (args.backend.kind === "disabled") {
    return { ...heuristicResult, fellThroughReason: "disabled" }
  }

  try {
    const outcome = await args.backend.decide({
      state: buildModelErrorTriageState(args.input),
      questions: MODEL_ERROR_TRIAGE_QUESTIONS,
      model: args.model,
    })

    if (outcome.status === "unavailable") {
      return { ...heuristicResult, fellThroughReason: outcome.reason }
    }

    const answer = outcome.answers.triage
    const jev = {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: outcome.model,
      latencyMs: outcome.latencyMs,
    }

    if (answer.confidence < args.confidenceThreshold) {
      return { ...heuristicResult, jev, fellThroughReason: "low_confidence" }
    }

    return {
      shouldRetry: answer.choice === "retry",
      source: "jev",
      heuristicShouldRetry,
      jev,
      threshold: args.confidenceThreshold,
      questionVersion: MODEL_ERROR_TRIAGE_QUESTION_VERSION,
    }
  } catch {
    return { ...heuristicResult, fellThroughReason: "transport_error" }
  }
}
