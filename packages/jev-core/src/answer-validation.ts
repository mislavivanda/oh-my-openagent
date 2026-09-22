import type { AnswerFor, Question, Questions } from "./types"

const PROBABILITY_SUM_TOLERANCE = 0.01
const SCORE_CONSISTENCY_TOLERANCE = 0.05
const FLOATING_POINT_EPSILON = 1e-9

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(record)
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key))
}

function readProbabilities(value: unknown, expectedKeys: readonly string[]): number[] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
    return undefined
  }

  const probabilities: number[] = []
  for (const key of expectedKeys) {
    const probability = value[key]
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return undefined
    }
    probabilities.push(probability)
  }

  const sum = probabilities.reduce((total, probability) => total + probability, 0)
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE + FLOATING_POINT_EPSILON) {
    return undefined
  }

  return probabilities
}

export function validateAnswer<Q extends Question>(question: Q, answer: unknown): answer is AnswerFor<Q> {
  if (!isRecord(answer) || answer.type !== question.type) {
    return false
  }

  switch (question.type) {
    case "choice": {
      if (
        typeof answer.choice !== "string" ||
        !(answer.choice in question.criteria) ||
        typeof answer.confidence !== "number" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return false
      }

      const expectedKeys = Object.keys(question.criteria)
      const probabilities = readProbabilities(answer.probabilities, expectedKeys)
      if (probabilities === undefined) {
        return false
      }

      const choiceIndex = expectedKeys.indexOf(answer.choice)
      return choiceIndex >= 0 && probabilities[choiceIndex] === Math.max(...probabilities)
    }

    case "noul":
      return (
        typeof answer.noul === "number" &&
        Number.isFinite(answer.noul) &&
        answer.noul >= 0 &&
        answer.noul <= 1
      )

    case "score": {
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        typeof answer.confidence !== "number" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return false
      }

      const expectedKeys = question.criteria.map((_, index) => String(index))
      if (!isRecord(answer.legend)) {
        return false
      }
      const legend = answer.legend
      if (
        !hasExactKeys(legend, expectedKeys) ||
        !expectedKeys.every((key, index) => legend[key] === question.criteria[index])
      ) {
        return false
      }

      const probabilities = readProbabilities(answer.probabilities, expectedKeys)
      if (probabilities === undefined) {
        return false
      }

      const weightedScore = probabilities.reduce(
        (total, probability, index) => total + index * probability,
        0,
      )
      return (
        Math.abs(answer.score - weightedScore) <=
        SCORE_CONSISTENCY_TOLERANCE + FLOATING_POINT_EPSILON
      )
    }
  }
}

export function validateAnswers<Q extends Questions>(
  questions: Q,
  raw: unknown,
): raw is { readonly [K in keyof Q]: AnswerFor<Q[K]> } {
  return (
    isRecord(raw) &&
    Object.keys(questions).every((id) => validateAnswer(questions[id], raw[id]))
  )
}
