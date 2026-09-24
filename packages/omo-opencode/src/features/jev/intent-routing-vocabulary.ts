import {
  INTENT_ROUTING_CATEGORY_VOCABULARY,
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
} from "@oh-my-opencode/jev-core"
import type { IntentRoutingVocabulary } from "@oh-my-opencode/jev-core"

const INTENT_OPTIONS = Object.freeze([
  { name: "implement", description: "Implement or modify a requested behavior." },
  { name: "investigate", description: "Investigate a failure, cause, or code path." },
  { name: "explain", description: "Explain a system, behavior, or concept." },
  { name: "review", description: "Review existing work or a proposed change." },
  { name: "author", description: "Author prose, documentation, or communication." },
  { name: "acknowledge", description: "Acknowledge without requesting further work." },
  { name: "continue", description: "Continue the prior task or conversation." },
] as const)

export const JEV_INTENT_ROUTING_VOCABULARY: IntentRoutingVocabulary = Object.freeze({
  categories: INTENT_ROUTING_CATEGORY_VOCABULARY.map((name) => Object.freeze({
    name,
    description: `Route through the ${name} task category.`,
  })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY.map((name) => Object.freeze({
    name,
    description: `Route directly to the ${name} subagent.`,
  })),
  intents: INTENT_OPTIONS,
})
