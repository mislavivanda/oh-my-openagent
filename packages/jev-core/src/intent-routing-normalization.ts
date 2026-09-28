import type {
  IntentRoutingAnswers,
  IntentRoutingObservedDelegation,
} from "./intent-routing-record"

export const INTENT_ROUTING_CATEGORY_VOCABULARY = Object.freeze([
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
])

export const INTENT_ROUTING_SUBAGENT_VOCABULARY = Object.freeze([
  "sisyphus",
  "hephaestus",
  "prometheus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
])

const RECOGNIZED_CATEGORIES = new Set<string>(INTENT_ROUTING_CATEGORY_VOCABULARY)

// AgentNameSchema is BuiltinAgentNameSchema. plan and build are override aliases only;
// general is absent from both live agent-name schemas.
const RECOGNIZED_SUBAGENTS = new Set<string>(INTENT_ROUTING_SUBAGENT_VOCABULARY)

export type ObservedDelegationArgs = {
  readonly tool: string
  readonly category?: unknown
  readonly subagent_type?: unknown
  readonly requested_subagent_type?: unknown
  readonly task_id?: unknown
}

export type NormalizedObservedDelegation = Pick<
  IntentRoutingObservedDelegation,
  "normalizedCategory" | "normalizedSubagent" | "routeClass"
>

export type IntentRoutingRoute =
  | "none"
  | `category:${string}`
  | `subagent:${string}`

export type DerivedRoute =
  | { readonly kind: "scorable"; readonly route: IntentRoutingRoute }
  | { readonly kind: "unscorable"; readonly reason: "resume" | "unknown" }

export type RouteObservation = Pick<
  IntentRoutingObservedDelegation,
  "normalizedCategory" | "normalizedSubagent" | "routeClass"
>

const UNKNOWN_NORMALIZATION: NormalizedObservedDelegation = Object.freeze({
  normalizedCategory: "none",
  normalizedSubagent: "none",
  routeClass: "unknown",
})

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecognizedSubagent(value: unknown): value is string {
  return isNonEmptyString(value) && RECOGNIZED_SUBAGENTS.has(value)
}

function isRecognizedCategory(value: unknown): value is string {
  return isNonEmptyString(value) && RECOGNIZED_CATEGORIES.has(value)
}

export function normalizeObservedDelegation(
  args: ObservedDelegationArgs,
): NormalizedObservedDelegation {
  if (args.tool !== "task" && args.tool !== "call_omo_agent") {
    return UNKNOWN_NORMALIZATION
  }

  const hasCategory = args.category !== undefined && args.category !== null
  const hasRequestedSubagent =
    args.requested_subagent_type !== undefined && args.requested_subagent_type !== null
  const hasSubagent = args.subagent_type !== undefined && args.subagent_type !== null

  if (hasCategory) {
    const hasOnlyCategoryRewrite =
      !hasSubagent || args.subagent_type === "sisyphus-junior"
    if (
      !isRecognizedCategory(args.category) ||
      hasRequestedSubagent ||
      !hasOnlyCategoryRewrite
    ) {
      return UNKNOWN_NORMALIZATION
    }

    return {
      normalizedCategory: args.category,
      normalizedSubagent: "none",
      routeClass: "category",
    }
  }

  if (hasRequestedSubagent) {
    if (!isRecognizedSubagent(args.requested_subagent_type)) {
      return UNKNOWN_NORMALIZATION
    }

    return {
      normalizedCategory: "none",
      normalizedSubagent: args.requested_subagent_type,
      routeClass: "subagent",
    }
  }

  if (hasSubagent) {
    if (!isRecognizedSubagent(args.subagent_type)) {
      return UNKNOWN_NORMALIZATION
    }

    return {
      normalizedCategory: "none",
      normalizedSubagent: args.subagent_type,
      routeClass: "subagent",
    }
  }

  if (args.tool === "task" && isNonEmptyString(args.task_id)) {
    return {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unscorable_resume",
    }
  }

  return UNKNOWN_NORMALIZATION
}

export function deriveRoute(observation: RouteObservation | null): DerivedRoute {
  if (observation === null) {
    return { kind: "scorable", route: "none" }
  }

  switch (observation.routeClass) {
    case "category":
      return {
        kind: "scorable",
        route: `category:${observation.normalizedCategory}`,
      }
    case "subagent":
      return {
        kind: "scorable",
        route: `subagent:${observation.normalizedSubagent}`,
      }
    case "unscorable_resume":
      return { kind: "unscorable", reason: "resume" }
    case "unknown":
      return { kind: "unscorable", reason: "unknown" }
    default: {
      const exhaustiveRouteClass: never = observation.routeClass
      return exhaustiveRouteClass
    }
  }
}

export function derivePredictedRoute(
  answers: IntentRoutingAnswers,
): { readonly route: IntentRoutingRoute; readonly coherent: boolean } {
  const category = answers.category.choice
  const subagent = answers.subagent.choice
  const hasCategory = category !== "none"
  const hasSubagent = subagent !== "none"

  if (hasCategory) {
    return {
      route: `category:${category}`,
      coherent: !hasSubagent,
    }
  }

  if (hasSubagent) {
    return {
      route: `subagent:${subagent}`,
      coherent: true,
    }
  }

  return { route: "none", coherent: true }
}
