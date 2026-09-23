import { expect, test } from "bun:test"
import type * as Sdk from "@typesafe-ai/sdk"
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionState,
  DecisionUsage,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from "./types"

export function compileTimeOnly(
  cq: ChoiceQuestion<"retry" | "stop" | "ignore">,
  nq: NoulQuestion,
  sq: ScoreQuestion,
  st: DecisionState,
  sdkCa: Sdk.ChoiceResponse<{ retry: string; stop: string; ignore: string }>,
  sdkNa: Sdk.NoulResponse,
  sdkSa: Sdk.ScoreResponse<readonly ["Calm", "Frustrated", "Very angry"]>,
  sdkU: Sdk.Usage,
): void {
  const a: Sdk.ChoiceQuestion<{
    retry: string | null
    stop: string | null
    ignore: string | null
  }> = cq
  const b: Sdk.NoulQuestion = nq
  const c: Sdk.ScoreQuestion<readonly [string, string, ...string[]]> = sq
  const d: Sdk.EntryType = st
  const e: ChoiceAnswer<"retry" | "stop" | "ignore"> = sdkCa
  const f: NoulAnswer = sdkNa
  const g: ScoreAnswer = sdkSa
  const h: DecisionUsage = sdkU
  void [a, b, c, d, e, f, g, h]
}

test("#given sdk type mirrors #when compiled #then the assertions above typecheck", () => {
  expect(true).toBe(true)
})
