import { expect, test } from "bun:test"
import type * as Sdk from "@typesafe-ai/sdk"
import { MODEL_ERROR_TRIAGE_QUESTIONS } from "./model-error-triage"
import type { AnswerFor, ChoiceAnswer, DecisionRequest } from "./types"

export function compileTimeOnly(
  req: DecisionRequest<typeof MODEL_ERROR_TRIAGE_QUESTIONS>,
  triageAnswer: AnswerFor<typeof MODEL_ERROR_TRIAGE_QUESTIONS["triage"]>,
  choiceAnswer: ChoiceAnswer<"retry" | "stop" | "ignore">,
): void {
  const sdkReq: Sdk.SystemOneRequest<typeof MODEL_ERROR_TRIAGE_QUESTIONS> = req
  const a: ChoiceAnswer<"retry" | "stop" | "ignore"> = triageAnswer
  const b: AnswerFor<typeof MODEL_ERROR_TRIAGE_QUESTIONS["triage"]> = choiceAnswer
  void [sdkReq, a, b]
}

test("#given the triage request and answer types #when compiled #then they are SDK-compatible in both directions", () => {
  expect(true).toBe(true)
})
