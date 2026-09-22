export type ChoiceQuestion<O extends string = string> = {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: Readonly<Record<O, string | null>>
}

export type NoulQuestion = {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: {
    readonly true?: string
    readonly false?: string
  }
}

export type ScoreQuestion = {
  readonly type: "score"
  readonly instructions: string
  readonly criteria: readonly [string, string, ...string[]]
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

export type ChoiceAnswer<O extends string = string> = {
  type: "choice"
  choice: O
  probabilities: Readonly<Record<O, number>>
  confidence: number
}

export type NoulAnswer = {
  type: "noul"
  noul: number
}

export type ScoreAnswer = {
  type: "score"
  score: number
  legend: Readonly<Record<string, JsonValue>>
  probabilities: Readonly<Record<string, number>>
  confidence: number
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

export type AnswerFor<Q extends Question> = Q extends {
  readonly type: "choice"
  readonly criteria: Readonly<Record<infer O extends string, unknown>>
}
  ? ChoiceAnswer<O>
  : Q extends { readonly type: "noul" }
    ? NoulAnswer
    : Q extends { readonly type: "score" }
      ? ScoreAnswer
      : never

export type Questions = Readonly<Record<string, Question>>

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type DecisionState = string | { [key: string]: JsonValue } | JsonValue[] | null

export type DecisionRequest<Q extends Questions> = {
  readonly state: DecisionState
  readonly questions: Q
  readonly model?: string
}

export type DecisionUsage = {
  readonly input_tokens: number
  readonly output_tokens: number
}

export type DecisionUnavailableReason =
  | "disabled"
  | "missing_api_key"
  | "timeout"
  | "transport_error"
  | "api_error"
  | "malformed_response"
  | "unscripted"
  | "not_implemented"

export type DecisionOutcome<Q extends Questions> =
  | {
      readonly status: "decided"
      readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> }
      readonly model: string
      readonly usage: DecisionUsage
      readonly latencyMs: number
    }
  | {
      readonly status: "unavailable"
      readonly reason: DecisionUnavailableReason
      readonly detail?: string
      readonly latencyMs: number
    }

export type DecisionBackendKind = "real" | "mock" | "llm-adapter"

export interface DecisionBackend {
  readonly kind: DecisionBackendKind | "disabled"
  decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>>
}
