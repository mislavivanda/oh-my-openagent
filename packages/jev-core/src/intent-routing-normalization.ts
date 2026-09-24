import type {
  IntentRoutingAnswers,
  IntentRoutingRouteClass,
} from "./intent-routing-record"
import type { IntentRoutingVocabularyEntry } from "./intent-routing"

export const INTENT_ROUTING_CATEGORY_VOCABULARY = Object.freeze([
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const)

// Plain data mirrors BuiltinAgentNameSchema and OverridableAgentNameSchema in
// packages/omo-opencode/src/config/schema/agent-names.ts. "general" is absent
// because neither live enum admits it.
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
  "build",
  "plan",
  "OpenCode-Builder",
] as const)

type ObservedDelegationArgs = Readonly<Record<string, unknown>>

type NormalizedDelegation = {
  readonly normalizedCategory: string
  readonly normalizedSubagent: string
  readonly routeClass: IntentRoutingRouteClass
}

type OptionalString =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: string }

type ScorableRoute = "none" | `category:${string}` | `subagent:${string}`

type DerivedRoute =
  | { readonly kind: "scorable"; readonly route: ScorableRoute }
  | { readonly kind: "unscorable"; readonly reason: "resume" | "unknown" }

const subagentNames = new Set<string>(INTENT_ROUTING_SUBAGENT_VOCABULARY)

function readOptionalString(args: ObservedDelegationArgs, key: string): OptionalString {
  const value = args[key]
  if (value === undefined || value === null) return { kind: "missing" }
  if (typeof value !== "string" || value.length === 0) return { kind: "invalid" }
  return { kind: "value", value }
}

function unknownDelegation(): NormalizedDelegation {
  return {
    normalizedCategory: "none",
    normalizedSubagent: "none",
    routeClass: "unknown",
  }
}

export function normalizeObservedDelegation(
  args: ObservedDelegationArgs,
  offeredCategories: readonly IntentRoutingVocabularyEntry[],
): NormalizedDelegation {
  const category = readOptionalString(args, "category")
  const subagent = readOptionalString(args, "subagent_type")
  const requestedSubagent = readOptionalString(args, "requested_subagent_type")
  const taskId = readOptionalString(args, "task_id")

  if (
    category.kind === "invalid" || subagent.kind === "invalid" ||
    requestedSubagent.kind === "invalid" || taskId.kind === "invalid"
  ) return unknownDelegation()

  if (category.kind === "value") {
    if (!offeredCategories.some(({ name }) => name === category.value)) return unknownDelegation()
    if (requestedSubagent.kind === "value") return unknownDelegation()
    if (subagent.kind === "value" && subagent.value !== "sisyphus-junior") {
      return unknownDelegation()
    }
    return {
      normalizedCategory: category.value,
      normalizedSubagent: "none",
      routeClass: "category",
    }
  }

  const effectiveSubagent = requestedSubagent.kind === "value" ? requestedSubagent : subagent
  if (effectiveSubagent.kind === "value") {
    if (!subagentNames.has(effectiveSubagent.value)) return unknownDelegation()
    return {
      normalizedCategory: "none",
      normalizedSubagent: effectiveSubagent.value,
      routeClass: "subagent",
    }
  }

  if (taskId.kind === "value") {
    return {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unscorable_resume",
    }
  }

  return {
    normalizedCategory: "none",
    normalizedSubagent: "none",
    routeClass: "none",
  }
}

export function deriveRoute(observation: NormalizedDelegation): DerivedRoute {
  switch (observation.routeClass) {
    case "none":
      return { kind: "scorable", route: "none" }
    case "category":
      return { kind: "scorable", route: `category:${observation.normalizedCategory}` }
    case "subagent":
      return { kind: "scorable", route: `subagent:${observation.normalizedSubagent}` }
    case "unscorable_resume":
      return { kind: "unscorable", reason: "resume" }
    case "unknown":
      return { kind: "unscorable", reason: "unknown" }
  }
}

export function derivePredictedRoute(
  answers: Pick<IntentRoutingAnswers, "category" | "subagent">,
): { readonly route: ScorableRoute | null; readonly coherent: boolean } {
  const category = answers.category.choice
  const subagent = answers.subagent.choice
  const hasCategory = category !== "none"
  const hasSubagent = subagent !== "none"

  if (hasCategory && hasSubagent) return { route: null, coherent: false }
  if (hasCategory) return { route: `category:${category}`, coherent: true }
  if (hasSubagent) return { route: `subagent:${subagent}`, coherent: true }
  return { route: "none", coherent: true }
}
