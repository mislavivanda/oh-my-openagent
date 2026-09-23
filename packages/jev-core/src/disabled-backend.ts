import type { DecisionBackend, DecisionOutcome, Questions } from "./types"

export function createDisabledDecisionBackend(): DecisionBackend {
  return {
    kind: "disabled",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return { status: "unavailable", reason: "disabled", latencyMs: 0 }
    },
  }
}
