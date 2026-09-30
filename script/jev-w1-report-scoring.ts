import {
  derivePredictedRoute,
  deriveRoute,
  type IntentRoutingObservationRecord,
  type IntentRoutingRoute,
} from "../packages/jev-core/src"
import type { Coverage, PreparedRecord, Rate } from "./jev-w1-report-types"

export function prepareRecord(record: IntentRoutingObservationRecord): PreparedRecord {
  const effectiveRoutes = new Set<IntentRoutingRoute | "unrepresentable">()
  const categoryTargets = new Set<string>()
  const subagentTargets = new Set<string>()
  let resumeCalls = 0
  let unknownCalls = 0
  for (const observation of record.observed) {
    const derived = deriveRoute(observation)
    if (derived.kind === "scorable") {
      effectiveRoutes.add(derived.route)
      if (observation.routeClass === "category") categoryTargets.add(observation.normalizedCategory)
      if (observation.routeClass === "subagent") subagentTargets.add(observation.normalizedSubagent)
    } else if (derived.reason === "resume") {
      resumeCalls += 1
    } else {
      unknownCalls += 1
      effectiveRoutes.add("unrepresentable")
    }
  }
  const prediction = derivePredictedRoute(record.answers)
  return {
    record,
    effectiveRoutes,
    categoryTargets,
    subagentTargets,
    resumeOnly: resumeCalls > 0 && resumeCalls === record.observed.length,
    unknownOnly: unknownCalls > 0 && unknownCalls === record.observed.length,
    hasUnknown: unknownCalls > 0,
    predictedRoute: prediction.route,
    coherent: prediction.coherent,
    routeAnswersValid: record.answers.category.valid && record.answers.subagent.valid,
  }
}

export function headlineBase(records: readonly PreparedRecord[]): readonly PreparedRecord[] {
  return records.filter((item) =>
    item.record.correlationStatus === "reliable" &&
    item.record.predictionStatus === "filled" &&
    !item.resumeOnly)
}

export function isAgreementCorrect(item: PreparedRecord): boolean {
  if (!item.coherent || !item.routeAnswersValid || item.effectiveRoutes.size > 1) return false
  if (item.effectiveRoutes.size === 0) return item.predictedRoute === "none"
  const actual = item.effectiveRoutes.values().next().value
  return actual !== "unrepresentable" && actual === item.predictedRoute
}

export function agreement(records: readonly PreparedRecord[]): Rate {
  const eligible = records.filter((item) => item.effectiveRoutes.size <= 1)
  return {
    numerator: eligible.filter(isAgreementCorrect).length,
    denominator: eligible.length,
  }
}

export function coherence(records: readonly PreparedRecord[]): Rate {
  return {
    numerator: records.filter((item) => item.coherent).length,
    denominator: records.length,
  }
}

export function noneRecall(records: readonly PreparedRecord[]): Rate {
  const actualNone = records.filter((item) => item.effectiveRoutes.size === 0)
  return {
    numerator: actualNone.filter(isAgreementCorrect).length,
    denominator: actualNone.length,
  }
}

export function nonePrecision(records: readonly PreparedRecord[]): Rate {
  const predictedNone = records.filter((item) => item.coherent && item.predictedRoute === "none")
  return {
    numerator: predictedNone.filter(isAgreementCorrect).length,
    denominator: predictedNone.length,
  }
}

type CoverageQuestion = "category" | "subagent"

export function coverage(records: readonly PreparedRecord[], question: CoverageQuestion): Coverage {
  let fractionalCovered = 0
  let eligibleTurns = 0
  let coveredTargets = 0
  let targetCount = 0
  for (const item of records) {
    const targets = question === "category" ? item.categoryTargets : item.subagentTargets
    if (targets.size === 0) continue
    eligibleTurns += 1
    targetCount += targets.size
    const answer = item.record.answers[question]
    const covered = answer.valid && answer.choice !== null && targets.has(answer.choice) ? 1 : 0
    coveredTargets += covered
    fractionalCovered += covered / targets.size
  }
  return { fractionalCovered, eligibleTurns, coveredTargets, targetCount }
}
