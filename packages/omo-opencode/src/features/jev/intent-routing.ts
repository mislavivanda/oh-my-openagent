import {
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
  decideIntentRouting,
  selectDecisionBackend,
  type DecisionBackend,
  type DecisionBackendDeps,
  type IntentRoutingDecisionResult,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import { isRealUserTextPart } from "../../shared"
import { log } from "../../shared/logger"
import { CATEGORY_DESCRIPTIONS, DEFAULT_CATEGORIES } from "../../tools/delegate-task"
import { getMainSessionID, subagentSessions } from "../claude-code-session-state"

const INTENT_VOCABULARY = [
  { name: "research", description: "Research or understanding before action." },
  { name: "implementation", description: "Explicit implementation work." },
  { name: "investigation", description: "Investigation followed by a report." },
  { name: "evaluation", description: "Evaluation before deciding whether to act." },
  { name: "fix", description: "Diagnosis followed by a minimal repair." },
  { name: "open-ended", description: "An open-ended change requiring assessment." },
] as const

const DEFAULT_VOCABULARY: IntentRoutingVocabulary = {
  categories: Object.keys(DEFAULT_CATEGORIES).map((name) => ({
    name,
    description: CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
  })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY
    .filter((name) => name !== "none")
    .map((name) => ({ name, description: `Delegate to the ${name} agent.` })),
  intents: INTENT_VOCABULARY,
}

export type JevIntentRoutingDispatcher = (args: {
  readonly backend: DecisionBackend
  readonly input: { readonly promptText: string }
  readonly vocab: IntentRoutingVocabulary
  readonly confidenceThreshold: number
  readonly model?: string
  readonly maxPromptChars: number
}) => Promise<IntentRoutingDecisionResult>

type JevIntentRoutingMessagePart = {
  readonly type?: string
  readonly text?: string
  readonly synthetic?: boolean
}

type JevIntentRoutingMessageOutput = {
  readonly parts?: readonly JevIntentRoutingMessagePart[]
}

export type JevIntentRouting = {
  readonly enabled: boolean
  readonly inFlight: number
  readonly dispatchesDropped: number
  observe(
    input: { readonly sessionID: unknown },
    output: JevIntentRoutingMessageOutput,
  ): void
}

type NotDispatchedReason =
  | "invalid_session_id"
  | "main_session_unknown"
  | "subagent_session"
  | "non_main_session"
  | "no_user_text"
  | "max_inflight"

function sessionNotDispatchedReason(sessionID: unknown): NotDispatchedReason | null {
  if (typeof sessionID !== "string" || sessionID.length === 0) return "invalid_session_id"
  const mainSessionID = getMainSessionID()
  if (mainSessionID === undefined) return "main_session_unknown"
  if (subagentSessions.has(sessionID)) return "subagent_session"
  if (sessionID !== mainSessionID) return "non_main_session"
  return null
}

export function isJevIntentRoutingSessionEligible(sessionID: unknown): sessionID is string {
  return sessionNotDispatchedReason(sessionID) === null
}

function snapshotPromptText(
  parts: JevIntentRoutingMessageOutput["parts"],
  maxChars: number,
): string {
  if (!Array.isArray(parts)) return ""
  let snapshot = ""
  let hasTextPart = false
  for (const part of parts) {
    if (!isRealUserTextPart(part)) continue
    const separator = hasTextPart ? "\n" : ""
    const remaining = maxChars - snapshot.length
    if (remaining <= 0) break
    snapshot += `${separator}${part.text}`.slice(0, remaining)
    hasTextPart = true
  }
  return snapshot
}

function safeBackendKind(backend: DecisionBackend): string {
  try {
    return backend.kind
  } catch {
    return "unknown"
  }
}

export function createJevIntentRouting(args: {
  readonly jevConfig: JevConfig | undefined
  readonly env?: {
    readonly TYPESAFE_API_KEY?: string
    readonly OMO_JEV_BASE_URL?: string
  }
  readonly backend?: DecisionBackend
  readonly dispatcher?: JevIntentRoutingDispatcher
  readonly fetch?: DecisionBackendDeps["fetch"]
  readonly logger?: (message: string, data?: unknown) => void
  readonly vocabulary?: IntentRoutingVocabulary
}): JevIntentRouting {
  const enabled = args.jevConfig?.enabled === true &&
    args.jevConfig.wires.intent_routing.enabled === true
  if (!enabled) {
    return { enabled: false, inFlight: 0, dispatchesDropped: 0, observe() {} }
  }

  const jevConfig = args.jevConfig
  const wireConfig = jevConfig.wires.intent_routing
  const env = args.env ?? process.env
  const logger = args.logger ?? log
  const safeLog = (message: string, data?: unknown): void => {
    try {
      logger(message, data)
    } catch (error) {
      if (error instanceof Error) return
      void String(error)
    }
  }
  const backendDeps: DecisionBackendDeps = {
    apiKey: env.TYPESAFE_API_KEY,
    ...(env.OMO_JEV_BASE_URL === undefined ? {} : { baseURL: env.OMO_JEV_BASE_URL }),
    ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
  }
  const backend = args.backend ?? selectDecisionBackend({
    enabled: true,
    backend: jevConfig.backend,
    model: jevConfig.model,
    timeoutMs: wireConfig.timeout_ms,
  }, backendDeps)
  const dispatcher = args.dispatcher ?? decideIntentRouting
  const vocabulary = args.vocabulary ?? DEFAULT_VOCABULARY
  let inFlight = 0
  let dispatchesDropped = 0

  const recordNotDispatched = (
    sessionID: unknown,
    reason: NotDispatchedReason,
  ): void => safeLog("[jev] intent-routing", {
    wire: "intent_routing",
    sessionID: typeof sessionID === "string" ? sessionID : null,
    backend: safeBackendKind(backend),
    predictionStatus: "not_dispatched",
    notDispatchedReason: reason,
  })

  const runDeferred = async (sessionID: unknown, promptText: string): Promise<void> => {
    const sessionReason = sessionNotDispatchedReason(sessionID)
    if (sessionReason !== null) {
      recordNotDispatched(sessionID, sessionReason)
      return
    }
    if (promptText.length === 0) {
      recordNotDispatched(sessionID, "no_user_text")
      return
    }
    if (inFlight >= wireConfig.max_inflight) {
      dispatchesDropped += 1
      recordNotDispatched(sessionID, "max_inflight")
      return
    }

    inFlight += 1
    try {
      const result = await dispatcher({
        backend,
        input: { promptText },
        vocab: vocabulary,
        confidenceThreshold: wireConfig.confidence_threshold,
        model: jevConfig.model,
        maxPromptChars: wireConfig.max_prompt_chars,
      })
      safeLog("[jev] intent-routing", {
        wire: "intent_routing",
        questionVersion: result.questionVersion,
        sessionID,
        backend: safeBackendKind(backend),
        predictionStatus: result.predictionStatus,
        notDispatchedReason: null,
        unavailableReason: result.unavailableReason,
        resolvedModel: result.resolvedModel,
        latencyMs: result.latencyMs,
        answers: result.answers,
        invalidAnswerCount: result.invalidAnswerCount,
        truncatedInput: result.truncatedInput,
      })
    } finally {
      inFlight -= 1
    }
  }

  return {
    enabled: true,
    get inFlight() { return inFlight },
    get dispatchesDropped() { return dispatchesDropped },
    observe(input, output): void {
      try {
        const sessionID = input.sessionID
        const promptText = snapshotPromptText(output.parts, wireConfig.max_prompt_chars)
        const handle = setTimeout(() => {
          runDeferred(sessionID, promptText).catch((error: unknown) => {
            safeLog("[jev] intent-routing failed", {
              wire: "intent_routing",
              sessionID: typeof sessionID === "string" ? sessionID : null,
              backend: safeBackendKind(backend),
              error: String(error).slice(0, 200),
            })
          })
        }, 0)
        handle.unref()
      } catch (error) {
        const detail = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
        safeLog("[jev] intent-routing failed", {
          wire: "intent_routing",
          error: detail.slice(0, 200),
        })
      }
    },
  }
}
