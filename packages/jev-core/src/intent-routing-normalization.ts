import type {
  IntentRoutingObservedDelegation,
  IntentRoutingRouteClass,
} from "./intent-routing-record"

export const INTENT_ROUTING_SUBAGENT_VOCABULARY = Object.freeze([
  "none",
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
] as const)

export type IntentRoutingRoute =
  | "none"
  | `category:${string}`
  | `subagent:${string}`

export type IntentRoutingDerivedRoute =
  | { readonly kind: "scorable"; readonly route: IntentRoutingRoute }
  | { readonly kind: "unscorable"; readonly reason: "resume" | "unknown" }

export type IntentRoutingPredictedRoute =
  | { readonly route: IntentRoutingRoute; readonly coherent: true }
  | { readonly route: null; readonly coherent: false }

export type IntentRoutingPredictionAnswers = {
  readonly category: { readonly choice: string | null }
  readonly subagent: { readonly choice: string | null }
}

type ObservedStringField =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly raw: string; readonly normalized: string }

function parseObservedString(
  args: Readonly<Record<string, unknown>>,
  key: string,
): ObservedStringField {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return { kind: "missing" }
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") return { kind: "invalid" }
  return { kind: "value", raw: value, normalized: value.trim() }
}

function rawObservedString(field: ObservedStringField): string | null {
  switch (field.kind) {
    case "value": return field.raw
    case "missing":
    case "invalid": return null
    default: {
      const unhandled: never = field
      return unhandled
    }
  }
}

function selectAuthoritativeSubagent(
  requested: ObservedStringField,
  actual: ObservedStringField,
): ObservedStringField {
  switch (requested.kind) {
    case "missing": return actual
    case "invalid":
    case "value": return requested
    default: {
      const unhandled: never = requested
      return unhandled
    }
  }
}

function canonicalSubagent(value: string): string | undefined {
  const normalized = value.toLowerCase()
  return INTENT_ROUTING_SUBAGENT_VOCABULARY.find(
    (candidate) => candidate !== "none" && candidate === normalized,
  )
}

export function normalizeObservedDelegation(
  args: Readonly<Record<string, unknown>>,
): IntentRoutingObservedDelegation {
  const category = parseObservedString(args, "category")
  const subagent = parseObservedString(args, "subagent_type")
  const requestedSubagent = parseObservedString(args, "requested_subagent_type")
  const taskId = parseObservedString(args, "task_id")
  const base = {
    tool: typeof args.tool === "string" ? args.tool : "",
    category: rawObservedString(category),
    subagentType: rawObservedString(subagent),
    requestedSubagentType: rawObservedString(requestedSubagent),
    taskId: rawObservedString(taskId),
    callID: typeof args.callID === "string" ? args.callID : null,
  }

  switch (category.kind) {
    case "value":
      if (category.normalized !== "none") {
        return {
          ...base,
          normalizedCategory: category.normalized,
          normalizedSubagent: "none",
          routeClass: "category",
        }
      }
      break
    case "invalid":
      return {
        ...base,
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unknown",
      }
    case "missing": break
    default: {
      const unhandled: never = category
      return unhandled
    }
  }

  const authoritativeSubagent = selectAuthoritativeSubagent(requestedSubagent, subagent)
  if (authoritativeSubagent.kind === "value") {
    const canonical = canonicalSubagent(authoritativeSubagent.normalized)
    if (canonical !== undefined) {
      return {
        ...base,
        normalizedCategory: "none",
        normalizedSubagent: canonical,
        routeClass: "subagent",
      }
    }
  }

  if (authoritativeSubagent.kind === "missing" && taskId.kind === "value") {
    return {
      ...base,
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unscorable_resume",
    }
  }

  return {
    ...base,
    normalizedCategory: "none",
    normalizedSubagent: "none",
    routeClass: "unknown",
  }
}

export function deriveRoute(
  observation: Pick<
    IntentRoutingObservedDelegation,
    "normalizedCategory" | "normalizedSubagent" | "routeClass"
  >,
): IntentRoutingDerivedRoute {
  switch (observation.routeClass) {
    case "category":
      return { kind: "scorable", route: `category:${observation.normalizedCategory}` }
    case "subagent":
      return { kind: "scorable", route: `subagent:${observation.normalizedSubagent}` }
    case "unscorable_resume":
      return { kind: "unscorable", reason: "resume" }
    case "unknown":
      return { kind: "unscorable", reason: "unknown" }
    default: {
      const unhandled: never = observation.routeClass
      return unhandled
    }
  }
}

export function derivePredictedRoute(
  answers: IntentRoutingPredictionAnswers,
): IntentRoutingPredictedRoute {
  const category = answers.category.choice
  const subagent = answers.subagent.choice
  if (category === null || subagent === null) return { route: null, coherent: false }

  const hasCategory = category !== "none"
  const hasSubagent = subagent !== "none"
  if (hasCategory && hasSubagent) return { route: null, coherent: false }
  if (hasCategory) return { route: `category:${category}`, coherent: true }
  if (hasSubagent) return { route: `subagent:${subagent}`, coherent: true }
  return { route: "none", coherent: true }
}

export type { IntentRoutingRouteClass }
