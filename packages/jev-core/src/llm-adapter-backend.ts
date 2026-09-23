import type { DecisionBackend, DecisionOutcome, Questions } from "./types"

export function createLlmAdapterDecisionBackend(): DecisionBackend {
  return {
    kind: "llm-adapter",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return { status: "unavailable", reason: "not_implemented", latencyMs: 0 }
    },
  }
}
