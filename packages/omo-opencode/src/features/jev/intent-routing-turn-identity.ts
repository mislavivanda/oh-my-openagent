import { createHash } from "node:crypto"

import type {
  IntentRoutingCorrelationStatus,
  IntentRoutingSealedBy,
} from "@oh-my-opencode/jev-core"

import { removeSystemReminders } from "../../shared"

export function normalizeIntentRoutingPrompt(textParts: readonly string[]): string {
  return removeSystemReminders(textParts.join("")).trim().replace(/\s+/gu, " ").toLowerCase()
}

export function createIntentRoutingPromptHash(textParts: readonly string[]): string {
  return createHash("sha256").update(normalizeIntentRoutingPrompt(textParts), "utf8").digest("hex")
}

export function createIntentRoutingPreDispatchKey(input: {
  readonly sessionID: string
  readonly promptHash: string
  readonly questionVersion: number
  readonly vocabularyDigest: string
  readonly confidenceThreshold: number
  readonly configuredModelSpec: string
}): string {
  return JSON.stringify([
    input.sessionID,
    input.promptHash,
    input.questionVersion,
    input.vocabularyDigest,
    input.confidenceThreshold,
    input.configuredModelSpec,
  ])
}

export function createIntentRoutingCompletedCacheKey(
  preDispatchKey: string,
  resolvedModel: string,
): string {
  return JSON.stringify([preDispatchKey, resolvedModel])
}

export function isPinnedIntentRoutingModelSpec(model: string): boolean {
  return /(?:^|\/)jev-\d{4}-\d{2}-\d{2}$/u.test(model)
}

export function classifyIntentRoutingCorrelationStatus(
  sealedBy: IntentRoutingSealedBy,
  overlapMarked: boolean,
): IntentRoutingCorrelationStatus {
  switch (sealedBy) {
    case "seal_timeout":
    case "dispose":
      return "censored"
    case "next_turn":
    case "session_idle":
    case "session_deleted":
      return overlapMarked ? "overlap_ambiguous" : "reliable"
  }
}
