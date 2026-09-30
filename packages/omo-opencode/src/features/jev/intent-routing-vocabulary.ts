import { createHash } from "crypto"
import {
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
  type IntentRoutingVocabulary,
} from "@oh-my-opencode/jev-core"
import { CATEGORY_DESCRIPTIONS, DEFAULT_CATEGORIES } from "../../tools/delegate-task"

const INTENT_VOCABULARY = [
  { name: "research", description: "Research or understanding before action." },
  { name: "implementation", description: "Explicit implementation work." },
  { name: "investigation", description: "Investigation followed by a report." },
  { name: "evaluation", description: "Evaluation before deciding whether to act." },
  { name: "fix", description: "Diagnosis followed by a minimal repair." },
  { name: "open-ended", description: "An open-ended change requiring assessment." },
] as const

export const DEFAULT_INTENT_ROUTING_VOCABULARY: IntentRoutingVocabulary = {
  categories: Object.keys(DEFAULT_CATEGORIES).map((name) => ({
    name,
    description: CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
  })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY
    .filter((name) => name !== "none")
    .map((name) => ({ name, description: `Delegate to the ${name} agent.` })),
  intents: INTENT_VOCABULARY,
}

export function intentRoutingVocabularyDigest(vocabulary: IntentRoutingVocabulary): string {
  return createHash("sha256").update(JSON.stringify(vocabulary)).digest("hex")
}
