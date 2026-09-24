import { expect } from "bun:test"

import {
  INTENT_ROUTING_NONE_OPTION,
  buildIntentRoutingQuestions,
  type IntentRoutingVocabulary,
} from "./intent-routing"
import * as intentRoutingModule from "./intent-routing"
import { choiceLabels, vocabulary } from "./intent-routing-test-vocabulary"
import {
  choiceAnswer,
  createMockDecisionBackend,
  type MockDecisionScript,
} from "./mock-backend"
import type {
  DecisionBackend,
  DecisionRequest,
  DecisionState,
  DecisionUnavailableReason,
  Questions,
} from "./types"

type ExpectedDecisionLabel = "would_apply" | "would_fall_through"

type ExpectedDecisionChoiceAnswer = {
  readonly choice: unknown
  readonly confidence: unknown
  readonly probabilities: unknown
  readonly valid: boolean
  readonly label: ExpectedDecisionLabel | null
}

export type ExpectedDecisionAnswers = {
  readonly intent: ExpectedDecisionChoiceAnswer
  readonly category: ExpectedDecisionChoiceAnswer
  readonly subagent: ExpectedDecisionChoiceAnswer
  readonly ambiguous: { readonly noul: unknown; readonly valid: boolean }
}

export type ExpectedDecisionResult = {
  readonly predictionStatus: "filled" | "failed"
  readonly truncatedInput: boolean
  readonly answers: ExpectedDecisionAnswers | null
  readonly invalidAnswerCount: number
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly resolvedModel: string | null
  readonly latencyMs: number | null
  readonly threshold: number
  readonly questionVersion: number
}

type ExpectedDecisionFunction = (args: {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}) => Promise<ExpectedDecisionResult>

function isExpectedDecisionFunction(value: unknown): value is ExpectedDecisionFunction {
  return typeof value === "function"
}

export function decisionFunction(): ExpectedDecisionFunction {
  const candidate: unknown = Reflect.get(intentRoutingModule, "decideIntentRouting")
  expect(typeof candidate).toBe("function")
  if (!isExpectedDecisionFunction(candidate)) {
    throw new TypeError("decideIntentRouting must be exported from intent-routing")
  }
  return candidate
}

export function routingScript(
  confidence: Partial<Record<"intent" | "category" | "subagent", number>> = {},
): MockDecisionScript {
  const questions = buildIntentRoutingQuestions(vocabulary())
  return {
    intent: choiceAnswer("implementation", confidence.intent ?? 0.92, choiceLabels(questions, "intent")),
    category: choiceAnswer("quick", confidence.category ?? 0.91, choiceLabels(questions, "category")),
    subagent: choiceAnswer(INTENT_ROUTING_NONE_OPTION, confidence.subagent ?? 0.9, choiceLabels(questions, "subagent")),
    ambiguous: { type: "noul", noul: 0.12 },
  }
}

export function requireAnswers(result: ExpectedDecisionResult): ExpectedDecisionAnswers {
  expect(result.predictionStatus).toBe("filled")
  expect(result.answers).not.toBeNull()
  if (result.answers === null) throw new TypeError("expected filled intent-routing answers")
  return result.answers
}

export function createTrackedBackend(base: DecisionBackend): {
  readonly backend: DecisionBackend
  readonly calls: () => number
  readonly state: () => DecisionState | undefined
  readonly questionKeys: () => readonly string[]
} {
  let calls = 0
  let state: DecisionState | undefined
  let questionKeys: readonly string[] = []
  return {
    backend: {
      kind: base.kind,
      async decide<Q extends Questions>(request: DecisionRequest<Q>) {
        calls += 1
        state = request.state
        questionKeys = Object.keys(request.questions)
        return base.decide(request)
      },
    },
    calls: () => calls,
    state: () => state,
    questionKeys: () => questionKeys,
  }
}

export function createCorruptingMock(corrupt: (answers: object) => void): DecisionBackend {
  const base = createMockDecisionBackend(routingScript(), { model: "jev-2026-09-24" })
  return {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>) {
      const outcome = await base.decide(request)
      if (outcome.status === "decided") corrupt(outcome.answers)
      return outcome
    },
  }
}
