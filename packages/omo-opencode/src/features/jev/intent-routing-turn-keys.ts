import { createHash } from "crypto"
import type { IntentRoutingPromptPart } from "./intent-routing-turn-types"

const SYSTEM_REMINDER_BLOCK = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/giu
const PINNED_JEV_MODEL = /(?:^|\/)jev-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export function normalizeIntentRoutingPrompt(parts: readonly IntentRoutingPromptPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .replace(SYSTEM_REMINDER_BLOCK, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
}

export function hashIntentRoutingPrompt(normalizedPrompt: string): string {
  return createHash("sha256").update(normalizedPrompt, "utf8").digest("hex")
}

export function buildIntentRoutingTierOneKey(input: {
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

export function buildIntentRoutingTierTwoKey(tierOneKey: string, resolvedModel: string): string {
  return JSON.stringify([tierOneKey, resolvedModel])
}

export function isPinnedIntentRoutingModelSpec(configuredModelSpec: string): boolean {
  return PINNED_JEV_MODEL.test(configuredModelSpec)
}
