import { decideIntentRouting, selectDecisionBackend } from "@oh-my-opencode/jev-core"
import type {
  DecisionBackend,
  DecisionBackendDeps,
  IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { log } from "../../shared"
import {
  createJevIntentRoutingDispatch,
  type IntentRoutingTextPart,
  type JevIntentRoutingDispatcher,
} from "./intent-routing-dispatch"
import {
  createJevIntentRoutingRuntime,
  type JevIntentRoutingRuntime,
} from "./intent-routing-runtime"
import { isJevIntentRoutingSessionEligible } from "./intent-routing-session-gate"
import type { IntentRoutingSink } from "./intent-routing-sink"

export { isJevIntentRoutingSessionEligible }
export type {
  JevIntentRoutingDispatcher,
  JevIntentRoutingDispatchRequest,
} from "./intent-routing-dispatch"
export type { JevIntentRoutingNotDispatchedReason } from "./intent-routing-session-gate"

export type JevIntentRouting = {
  readonly enabled: boolean
  readonly inFlight: number
  readonly dispatchesDropped: number
  dispatch(
    input: { readonly sessionID: string },
    output: { readonly parts: readonly IntentRoutingTextPart[] },
  ): void
  capture(
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string },
    output: { readonly args: Record<string, unknown> },
  ): boolean
  handleSessionIdle(sessionID: string): void
  handleSessionDeleted(sessionID: string): void
  dispose(): Promise<void>
}

const DISABLED_INTENT_ROUTING: JevIntentRouting = Object.freeze({
  enabled: false,
  inFlight: 0,
  dispatchesDropped: 0,
  dispatch() {},
  capture: () => false,
  handleSessionIdle() {},
  handleSessionDeleted() {},
  async dispose() {},
})

export function createJevIntentRouting(args: {
  readonly jevConfig: JevConfig | undefined
  readonly vocab: IntentRoutingVocabulary
  readonly env?: { readonly TYPESAFE_API_KEY?: string; readonly OMO_JEV_BASE_URL?: string }
  readonly backend?: DecisionBackend
  readonly fetch?: DecisionBackendDeps["fetch"]
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly logger?: (message: string, data?: unknown) => void
  readonly runtime?: JevIntentRoutingRuntime
  readonly sink?: IntentRoutingSink
}): JevIntentRouting {
  const enabled =
    args.jevConfig?.enabled === true && args.jevConfig.wires.intent_routing.enabled === true
  if (!enabled) return DISABLED_INTENT_ROUTING

  const jevConfig = args.jevConfig
  const wireConfig = jevConfig.wires.intent_routing
  const env = args.env ?? process.env
  const backendDeps = {
    apiKey: env.TYPESAFE_API_KEY,
    ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    ...(env.OMO_JEV_BASE_URL === undefined ? {} : { baseURL: env.OMO_JEV_BASE_URL }),
  } satisfies DecisionBackendDeps
  const backend = args.backend ?? selectDecisionBackend(
    {
      enabled: true,
      backend: jevConfig.backend,
      model: jevConfig.model,
      timeoutMs: wireConfig.timeout_ms,
    },
    backendDeps,
  )
  const dispatcher = args.dispatcher ?? (async (request) => {
    const result = await decideIntentRouting({
      backend,
      input: { promptText: request.promptText },
      vocab: args.vocab,
      confidenceThreshold: wireConfig.confidence_threshold,
      model: jevConfig.model,
      maxPromptChars: wireConfig.max_prompt_chars,
    })
    return request.truncatedInput && !result.truncatedInput
      ? { ...result, truncatedInput: true }
      : result
  })
  const runtime = args.runtime ?? createJevIntentRoutingRuntime({
    jevConfig,
    vocab: args.vocab,
    ...(args.sink === undefined ? {} : { sink: args.sink }),
  })
  const routingDispatch = createJevIntentRoutingDispatch({
    backend,
    dispatcher,
    logger: args.logger ?? log,
    runtime,
    wireConfig,
  })

  return {
    enabled: true,
    get inFlight() { return routingDispatch.inFlight },
    get dispatchesDropped() { return routingDispatch.dispatchesDropped },
    dispatch: routingDispatch.dispatch,
    capture(input, output) {
      return runtime.capture(input, output)
    },
    handleSessionIdle(sessionID) {
      runtime.handleSessionIdle(sessionID)
    },
    handleSessionDeleted(sessionID) {
      runtime.handleSessionDeleted(sessionID)
    },
    dispose() {
      return runtime.dispose()
    },
  }
}
