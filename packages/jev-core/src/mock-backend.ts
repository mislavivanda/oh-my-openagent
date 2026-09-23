import { isRecord, validateAnswer, validateAnswers } from "./answer-validation"
import type {
  Answer,
  ChoiceAnswer,
  DecisionBackend,
  DecisionOutcome,
  DecisionRequest,
  Questions,
} from "./types"

export type MockDecisionScript = Readonly<Record<string, Answer>>

function hasOptionProbabilities<O extends string>(
  value: unknown,
  options: readonly O[],
): value is Readonly<Record<O, number>> {
  return isRecord(value) && options.every((option) => typeof value[option] === "number")
}

export function createMockDecisionBackend(
  script: MockDecisionScript,
  options?: { readonly model?: string },
): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      const startedAt = performance.now()
      const raw = Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, script[id]]),
      )

      if (!validateAnswers(request.questions, raw)) {
        const detail = Object.keys(request.questions).find(
          (id) => !validateAnswer(request.questions[id], script[id]),
        )
        return {
          status: "unavailable",
          reason: "unscripted",
          detail,
          latencyMs: performance.now() - startedAt,
        }
      }

      return {
        status: "decided",
        answers: raw,
        model: options?.model ?? "mock",
        usage: { input_tokens: 0, output_tokens: 0 },
        latencyMs: performance.now() - startedAt,
      }
    },
  }
}

export function choiceAnswer<O extends string>(
  choice: O,
  confidence: number,
  options: readonly O[],
): ChoiceAnswer<O> {
  const otherOptionCount = options.length - 1
  const otherProbability = otherOptionCount === 0 ? 0 : (1 - confidence) / otherOptionCount
  const probabilities = Object.fromEntries(
    options.map((option) => [option, option === choice ? confidence : otherProbability]),
  )
  if (!hasOptionProbabilities(probabilities, options)) {
    throw new TypeError("Could not construct choice probabilities")
  }

  return {
    type: "choice",
    choice,
    probabilities,
    confidence,
  }
}
