import {
  derivePredictedRoute,
  deriveRoute,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

export const FAN_OUT_BUCKETS = ["zero", "one", "many"] as const
export const SEALED_BY_VALUES = ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const

export type JevW1ScoredTurn = {
  readonly record: IntentRoutingObservationRecord
  readonly routes: ReadonlySet<string>
  readonly categoryTargets: ReadonlySet<string>
  readonly subagentTargets: ReadonlySet<string>
  readonly hasUnknown: boolean
  readonly coherent: boolean
  readonly predictedRoute: string | null
  readonly routeAnswersValid: boolean
  readonly categoryCorrect: boolean
  readonly subagentCorrect: boolean
  readonly actualNone: boolean
  readonly predictedNone: boolean
  readonly routeCorrect: boolean
}

export type JevW1Metric = { readonly numerator: number; readonly denominator: number }
export type JevW1CoverageMetric = JevW1Metric & {
  readonly targetCardinality: number
  readonly weightedNumerator: number
  readonly weightedDenominator: number
}
export type JevW1MetricSet = {
  readonly exact: JevW1Metric
  readonly category: JevW1CoverageMetric
  readonly subagent: JevW1CoverageMetric
  readonly noneRecall: JevW1Metric
  readonly nonePrecision: JevW1Metric
  readonly coherence: JevW1Metric
  readonly multiRouteTurns: number
}

export function isResumeOnly(record: IntentRoutingObservationRecord): boolean {
  return record.observed.length > 0 && record.observed.every((item) => item.routeClass === "unscorable_resume")
}

export function isUnknownOnly(record: IntentRoutingObservationRecord): boolean {
  const substantive = record.observed.filter((item) => item.routeClass !== "unscorable_resume")
  return substantive.length > 0 && substantive.every((item) => item.routeClass === "unknown")
}

export function countRecords<T extends string>(
  records: readonly IntentRoutingObservationRecord[],
  key: (record: IntentRoutingObservationRecord) => T,
  value: T,
): number {
  return records.filter((record) => key(record) === value).length
}

export function toScoredTurn(record: IntentRoutingObservationRecord): JevW1ScoredTurn {
  const routes = new Set<string>()
  const categoryTargets = new Set<string>()
  const subagentTargets = new Set<string>()
  let hasUnknown = false
  for (const observation of record.observed) {
    const derived = deriveRoute(observation)
    if (derived.kind === "scorable") routes.add(derived.route)
    else if (derived.reason === "unknown") hasUnknown = true
    if (observation.routeClass === "category") categoryTargets.add(observation.normalizedCategory)
    if (observation.routeClass === "subagent") subagentTargets.add(observation.normalizedSubagent)
  }
  const prediction = record.answers === null
    ? { route: null, coherent: false }
    : derivePredictedRoute(record.answers)
  const routeAnswersValid = record.answers !== null && record.answers.category.valid && record.answers.subagent.valid
  const actualNone = !hasUnknown && (routes.size === 0 || (routes.size === 1 && routes.has("none")))
  const actualRoute = actualNone ? "none" : routes.size === 1 ? [...routes][0] ?? null : null
  const categoryChoice = record.answers?.category.choice ?? null
  const subagentChoice = record.answers?.subagent.choice ?? null
  return {
    record,
    routes,
    categoryTargets,
    subagentTargets,
    hasUnknown,
    coherent: prediction.coherent,
    predictedRoute: prediction.route,
    routeAnswersValid,
    categoryCorrect: record.answers?.category.valid === true && !hasUnknown && (
      categoryTargets.size === 0 ? categoryChoice === "none" : categoryChoice !== null && categoryTargets.has(categoryChoice)
    ),
    subagentCorrect: record.answers?.subagent.valid === true && !hasUnknown && (
      subagentTargets.size === 0 ? subagentChoice === "none" : subagentChoice !== null && subagentTargets.has(subagentChoice)
    ),
    actualNone,
    predictedNone: prediction.route === "none",
    routeCorrect: routeAnswersValid && prediction.coherent && !hasUnknown && prediction.route === actualRoute,
  }
}

function coverage(turns: readonly JevW1ScoredTurn[], target: "category" | "subagent"): JevW1CoverageMetric {
  let numerator = 0
  let targetCardinality = 0
  let weightedNumerator = 0
  let weightedDenominator = 0
  for (const turn of turns) {
    const targets = target === "category" ? turn.categoryTargets : turn.subagentTargets
    const correct = target === "category" ? turn.categoryCorrect : turn.subagentCorrect
    const weight = Math.max(1, targets.size)
    numerator += Number(correct)
    targetCardinality += targets.size
    weightedNumerator += correct ? weight : 0
    weightedDenominator += weight
  }
  return { numerator, denominator: turns.length, targetCardinality, weightedNumerator, weightedDenominator }
}

export function calculateJevW1Metrics(turns: readonly JevW1ScoredTurn[]): JevW1MetricSet {
  const exactTurns = turns.filter((turn) => turn.routes.size < 2)
  const actualNoneTurns = turns.filter((turn) => turn.actualNone)
  const predictedNoneTurns = turns.filter((turn) => turn.predictedNone)
  return {
    exact: { numerator: exactTurns.filter((turn) => turn.routeCorrect).length, denominator: exactTurns.length },
    category: coverage(turns, "category"),
    subagent: coverage(turns, "subagent"),
    noneRecall: { numerator: actualNoneTurns.filter((turn) => turn.routeAnswersValid && turn.predictedNone).length, denominator: actualNoneTurns.length },
    nonePrecision: { numerator: predictedNoneTurns.filter((turn) => turn.routeAnswersValid && turn.actualNone).length, denominator: predictedNoneTurns.length },
    coherence: { numerator: turns.filter((turn) => turn.coherent).length, denominator: turns.length },
    multiRouteTurns: turns.filter((turn) => turn.routes.size >= 2).length,
  }
}
