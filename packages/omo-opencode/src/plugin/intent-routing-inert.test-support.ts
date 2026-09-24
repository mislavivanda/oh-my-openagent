import type {
  IntentRoutingDecisionResult,
  IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"

import { JevConfigSchema } from "../config/schema/jev"
import {
  createJevIntentRouting,
  type JevIntentRouting,
  type JevIntentRoutingDispatcher,
} from "../features/jev"
import { createIntentRoutingTestSink } from "../features/jev/intent-routing-test-sink"
import type { ChatMessageHooks } from "./chat-message/types"

export const INTENT_ROUTING_FAILURE_SHAPES = [
  "throws_synchronously",
  "rejects_asynchronously",
  "times_out",
] as const

export type IntentRoutingFailureShape = typeof INTENT_ROUTING_FAILURE_SHAPES[number]

export const CHAT_HOOK_ORDER = [
  "modelFallback",
  "stopContinuationGuard",
  "backgroundNotificationHook",
  "runtimeFallback",
  "keywordDetector",
  "thinkMode",
  "claudeCodeHooks",
  "autoSlashCommand",
  "noSisyphusGpt",
  "noHephaestusNonGpt",
  "hephaestusAgentsMdInjector",
] as const

export const TOOL_HOOK_ORDER = [
  "writeExistingFileGuard",
  "notepadWriteGuard",
  "questionLabelTruncator",
  "claudeCodeHooks",
  "nonInteractiveEnv",
  "bashFileReadGuard",
  "commentChecker",
  "directoryAgentsInjector",
  "directoryReadmeInjector",
  "rulesInjector",
  "tasksTodowriteDisabler",
  "webfetchRedirectGuard",
  "fsyncSkipWarning",
  "prometheusMdOnly",
  "sisyphusJuniorNotepad",
  "atlasHook",
  "compactionTodoPreserver",
  "teamToolGating",
] as const

export const INTENT_ROUTING_VOCABULARY: IntentRoutingVocabulary = {
  categories: [{ name: "quick", description: "Small focused work." }],
  subagents: [{ name: "explore", description: "Codebase reconnaissance." }],
  intents: [{ name: "implementation", description: "Write code." }],
}

const TIMED_OUT_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "failed",
  truncatedInput: false,
  answers: null,
  invalidAnswerCount: 0,
  unavailableReason: "timeout",
  resolvedModel: null,
  latencyMs: 100,
  threshold: 0.8,
  questionVersion: 1,
}

function failureDispatcher(shape: IntentRoutingFailureShape): JevIntentRoutingDispatcher {
  switch (shape) {
    case "throws_synchronously":
      return () => {
        throw new TypeError("synchronous backend failure")
      }
    case "rejects_asynchronously":
      return () => Promise.reject(new TypeError("asynchronous backend failure"))
    case "times_out":
      return async () => TIMED_OUT_RESULT
  }
}

export function createInertRouting(
  enabled: boolean,
  shape: IntentRoutingFailureShape,
): JevIntentRouting {
  return createJevIntentRouting({
    jevConfig: JevConfigSchema.parse({
      enabled,
      backend: "mock",
      model: "jev-test",
      wires: { intent_routing: { enabled } },
    }),
    vocab: INTENT_ROUTING_VOCABULARY,
    dispatcher: failureDispatcher(shape),
    logger: () => undefined,
    sink: createIntentRoutingTestSink(),
  })
}

function chatHook(order: string[], name: string) {
  return { "chat.message": async () => { order.push(name) } }
}

export function createChatHookLedger(order: string[]): ChatMessageHooks {
  return {
    modelFallback: chatHook(order, "modelFallback"),
    stopContinuationGuard: {
      "chat.message": async () => { order.push("stopContinuationGuard") },
      stop: () => undefined,
      isStopped: () => false,
      clear: () => undefined,
    },
    backgroundNotificationHook: chatHook(order, "backgroundNotificationHook"),
    runtimeFallback: chatHook(order, "runtimeFallback"),
    keywordDetector: chatHook(order, "keywordDetector"),
    thinkMode: chatHook(order, "thinkMode"),
    claudeCodeHooks: chatHook(order, "claudeCodeHooks"),
    autoSlashCommand: chatHook(order, "autoSlashCommand"),
    noSisyphusGpt: chatHook(order, "noSisyphusGpt"),
    noHephaestusNonGpt: chatHook(order, "noHephaestusNonGpt"),
    hephaestusAgentsMdInjector: chatHook(order, "hephaestusAgentsMdInjector"),
  }
}

export async function runDeferredMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}
