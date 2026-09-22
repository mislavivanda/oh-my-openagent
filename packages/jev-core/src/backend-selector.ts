import { createDisabledDecisionBackend } from "./disabled-backend"
import { createLlmAdapterDecisionBackend } from "./llm-adapter-backend"
import { createMockDecisionBackend, type MockDecisionScript } from "./mock-backend"
import { createRealDecisionBackend, type RealDecisionBackendDeps } from "./real-backend"
import type { DecisionBackend, DecisionBackendKind } from "./types"

export type DecisionBackendConfig = {
  readonly enabled: boolean
  readonly backend: DecisionBackendKind
  readonly model: string
  readonly timeoutMs: number
}

export type DecisionBackendDeps = {
  readonly apiKey?: string
  readonly fetch?: RealDecisionBackendDeps["fetch"]
  readonly baseURL?: string
  readonly logger?: RealDecisionBackendDeps["logger"]
  readonly mockScript?: MockDecisionScript
}

export function selectDecisionBackend(
  config: DecisionBackendConfig,
  deps: DecisionBackendDeps = {},
): DecisionBackend {
  if (!config.enabled) {
    return createDisabledDecisionBackend()
  }

  switch (config.backend) {
    case "mock":
      return createMockDecisionBackend(deps.mockScript ?? {})
    case "llm-adapter":
      return createLlmAdapterDecisionBackend()
    case "real":
      return createRealDecisionBackend({
        apiKey: deps.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
        fetch: deps.fetch,
        baseURL: deps.baseURL,
        logger: deps.logger,
      })
    default: {
      const exhaustive: never = config.backend
      return exhaustive
    }
  }
}
