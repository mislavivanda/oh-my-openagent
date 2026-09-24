import { createHash } from "node:crypto"

import {
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"

import type { AvailableCategory } from "../../agents/dynamic-agent-prompt-builder"

const INTENT_ROUTING_INTENTS = [
  { name: "research", description: "Gather external or internal evidence before deciding." },
  { name: "implementation", description: "Create or change code or configuration." },
  { name: "investigation", description: "Trace behavior, architecture, or a failure." },
  { name: "evaluation", description: "Review, compare, or assess existing work." },
  { name: "fix", description: "Correct a known defect or regression." },
  { name: "open-ended", description: "Handle a request without a narrower intent class." },
] as const

export function createJevIntentRoutingVocabulary(
  categories: readonly AvailableCategory[],
): IntentRoutingVocabulary {
  return {
    categories: categories.map(({ name, description }) => ({ name, description })),
    subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY.map((name) => ({
      name,
      description: `Route directly to the ${name} agent.`,
    })),
    intents: INTENT_ROUTING_INTENTS,
  }
}

export function createJevIntentRoutingVocabularyDigest(
  vocabulary: IntentRoutingVocabulary,
): string {
  return createHash("sha256").update(JSON.stringify(vocabulary), "utf8").digest("hex")
}
