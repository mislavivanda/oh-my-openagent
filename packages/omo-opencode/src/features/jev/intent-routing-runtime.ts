import { createHash } from "node:crypto"
import { INTENT_ROUTING_QUESTION_VERSION } from "@oh-my-opencode/jev-core"
import type {
  IntentRoutingDecisionResult,
  IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import type { JevConfig } from "../../config/schema/jev"
import {
  createJevIntentRoutingCapture,
  type JevIntentRoutingCapture,
} from "./intent-routing-capture"
import { createIntentRoutingSeal } from "./intent-routing-seal"
import {
  createIntentRoutingSink,
  type IntentRoutingSink,
} from "./intent-routing-sink"

const MAX_TRACKED_SESSIONS = 1_000
const MAX_TURNS_PER_SESSION = 100

type IntentRoutingTextPart = Readonly<{
  type?: string
  text?: string
  synthetic?: boolean
}>

export type JevIntentRoutingRuntime = Readonly<{
  handleMessage(input: Readonly<{
    sessionID: string
    parts: readonly IntentRoutingTextPart[]
    truncatedInput: boolean
    dispatch?: (() => Promise<IntentRoutingDecisionResult>) | undefined
    notDispatchedReason?: string | undefined
  }>): void
  capture: JevIntentRoutingCapture["capture"]
  handleSessionIdle(sessionID: string): void
  handleSessionDeleted(sessionID: string): void
  dispose(): Promise<void>
}>

export function createJevIntentRoutingRuntime(args: Readonly<{
  jevConfig: JevConfig
  vocab: IntentRoutingVocabulary
  sink?: IntentRoutingSink
}>): JevIntentRoutingRuntime {
  const wireConfig = args.jevConfig.wires.intent_routing
  const sink = args.sink ?? createIntentRoutingSink()
  const vocabularyDigest = createHash("sha256")
    .update(JSON.stringify(args.vocab))
    .digest("hex")
  const seal = createIntentRoutingSeal({
    maxTrackedSessions: MAX_TRACKED_SESSIONS,
    maxTurnsPerSession: MAX_TURNS_PER_SESSION,
    processId: sink.processId,
    counterEpoch: sink.counterEpoch,
    turnSealTimeoutMs: wireConfig.turn_seal_timeout_ms,
    sink: (entry) => sink.write(entry),
    disposeSink: () => sink.dispose(),
  })
  const capture = createJevIntentRoutingCapture(seal)

  return {
    handleMessage(input) {
      seal.handleMessage({
        sessionID: input.sessionID,
        parts: input.parts,
        questionVersion: INTENT_ROUTING_QUESTION_VERSION,
        vocabularyDigest,
        confidenceThreshold: wireConfig.confidence_threshold,
        configuredModelSpec: args.jevConfig.model,
        predictionTimeoutMs: wireConfig.timeout_ms,
        truncatedInput: input.truncatedInput,
        dispatch: input.dispatch,
        notDispatchedReason: input.notDispatchedReason,
      })
    },
    capture: capture.capture,
    handleSessionIdle: seal.handleSessionIdle,
    handleSessionDeleted: seal.handleSessionDeleted,
    dispose: seal.dispose,
  }
}
