import type { IntentRoutingObservationRecord, IntentRoutingRoute } from "../packages/jev-core/src"

export const FAN_OUT_BUCKETS = ["zero", "one", "many"] as const
export const SEALED_BY_VALUES = ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const

export type Rate = {
  readonly numerator: number
  readonly denominator: number
}

export type Coverage = {
  readonly fractionalCovered: number
  readonly eligibleTurns: number
  readonly coveredTargets: number
  readonly targetCount: number
}

export type PreparedRecord = {
  readonly record: IntentRoutingObservationRecord
  readonly effectiveRoutes: ReadonlySet<IntentRoutingRoute | "unrepresentable">
  readonly categoryTargets: ReadonlySet<string>
  readonly subagentTargets: ReadonlySet<string>
  readonly resumeOnly: boolean
  readonly unknownOnly: boolean
  readonly hasUnknown: boolean
  readonly predictedRoute: IntentRoutingRoute | null
  readonly coherent: boolean
  readonly routeAnswersValid: boolean
}

export type ReportAnalysis = {
  readonly denominators: Readonly<Record<string, number>>
  readonly identity: {
    readonly created: number
    readonly sealed: number
    readonly evicted: number
    readonly inFlight: number
  }
  readonly routeAgreement: Rate
  readonly coherence: Rate
  readonly noneRecall: Rate
  readonly nonePrecision: Rate
  readonly categoryCoverage: Coverage
  readonly subagentCoverage: Coverage
  readonly multiRouteTurns: number
  readonly fanOutAgreement: Readonly<Record<(typeof FAN_OUT_BUCKETS)[number], Rate>>
  readonly sealedByAgreement: Readonly<Record<(typeof SEALED_BY_VALUES)[number], Rate>>
  readonly continuationAgreement: Rate
  readonly disagreementShaCounts: ReadonlyMap<string, number>
}
