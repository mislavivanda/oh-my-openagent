// allow: SIZE_OK - the report keeps eligibility, metric definitions, and their rendered denominators auditable together.
import {
  derivePredictedRoute,
  deriveRoute,
  INTENT_ROUTING_FIXTURES,
  type IntentRoutingAnswers,
  type IntentRoutingObservationRecord,
  type IntentRoutingRoute,
} from "@oh-my-opencode/jev-core"
import {
  getIntentRoutingSinkDirectory,
  readIntentRoutingSink,
} from "../packages/omo-opencode/src/features/jev/intent-routing-sink-reader"

const PREDICTION_STATUSES = ["filled", "failed", "timeout", "not_dispatched"] as const
const CORRELATION_STATUSES = ["reliable", "censored", "overlap_ambiguous"] as const
const SEALED_BY_VALUES = ["next_turn", "session_idle", "seal_timeout", "dispose", "session_deleted"] as const
const FAN_OUT_BUCKETS = ["zero", "one", "many"] as const

type AnalyzedRecord = Readonly<{
  record: IntentRoutingObservationRecord
  answers: IntentRoutingAnswers | null
  predictedRoute: IntentRoutingRoute | null
  coherent: boolean
  categoryTargets: ReadonlySet<string>
  subagentTargets: ReadonlySet<string>
  knownRoutes: ReadonlySet<IntentRoutingRoute>
  hasResume: boolean
  hasUnknown: boolean
  unknownCalls: number
  resumeOnly: boolean
  unknownOnly: boolean
}>

type Rate = Readonly<{ numerator: number; denominator: number }>
type Coverage = Readonly<{ hits: number; turns: number; distinctTargets: number }>
type FixtureBaseRate = Readonly<{ choice: string; numerator: number; denominator: number }>

class ReportArgumentError extends Error {
  constructor() {
    super("--root requires a directory")
    this.name = "ReportArgumentError"
  }
}

function analyzeRecord(record: IntentRoutingObservationRecord): AnalyzedRecord {
  const knownRoutes = new Set<IntentRoutingRoute>()
  let hasResume = false
  let hasUnknown = false
  let unknownCalls = 0
  for (const observation of record.observed) {
    const derived = deriveRoute(observation)
    switch (derived.kind) {
      case "scorable":
        knownRoutes.add(derived.route)
        break
      case "unscorable":
        switch (derived.reason) {
          case "resume":
            hasResume = true
            break
          case "unknown":
            hasUnknown = true
            unknownCalls += 1
            break
          default: {
            const exhaustiveReason: never = derived.reason
            return exhaustiveReason
          }
        }
        break
      default: {
        const exhaustiveKind: never = derived
        return exhaustiveKind
      }
    }
  }
  knownRoutes.delete("none")

  const categoryTargets = new Set(record.observed.filter((item) => item.routeClass === "category").map((item) => item.normalizedCategory))
  const subagentTargets = new Set(record.observed.filter((item) => item.routeClass === "subagent").map((item) => item.normalizedSubagent))
  const answers = record.predictionStatus === "filled" ? record.answers : null
  const predicted = answers === null ? null : derivePredictedRoute(answers)
  return {
    record, answers, predictedRoute: predicted?.route ?? null, coherent: predicted?.coherent ?? false,
    categoryTargets, subagentTargets, knownRoutes, hasResume, hasUnknown, unknownCalls,
    resumeOnly: hasResume && knownRoutes.size === 0 && !hasUnknown,
    unknownOnly: hasUnknown && knownRoutes.size === 0,
  }
}

function isRateEligible(item: AnalyzedRecord): boolean {
  return item.record.correlationStatus === "reliable" &&
    item.record.predictionStatus === "filled" && item.answers !== null &&
    item.predictedRoute !== null && !item.resumeOnly
}

function isExactEligible(item: AnalyzedRecord): boolean {
  return isRateEligible(item) && item.knownRoutes.size <= 1
}

function isRouteCorrect(item: AnalyzedRecord): boolean {
  if (!isExactEligible(item) || item.hasUnknown || !item.coherent || item.answers === null) return false
  if (!item.answers.category.valid || !item.answers.subagent.valid) return false
  const expectedRoute = [...item.knownRoutes][0] ?? "none"
  return item.predictedRoute === expectedRoute
}

function routeRate(items: readonly AnalyzedRecord[]): Rate {
  const eligible = items.filter(isExactEligible)
  return { numerator: eligible.filter(isRouteCorrect).length, denominator: eligible.length }
}

function questionCoverage(items: readonly AnalyzedRecord[], question: "category" | "subagent"): Coverage {
  const eligible = items.filter((item) => {
    if (!isRateEligible(item)) return false
    return question === "category" ? item.categoryTargets.size > 0 : item.subagentTargets.size > 0
  })
  let hits = 0
  let distinctTargets = 0
  for (const item of eligible) {
    const targets = question === "category" ? item.categoryTargets : item.subagentTargets
    const answer = question === "category" ? item.answers?.category : item.answers?.subagent
    distinctTargets += targets.size
    if (item.coherent && answer?.valid === true && targets.has(answer.choice)) hits += 1
  }
  return { hits, turns: eligible.length, distinctTargets }
}

function countBy<T extends string>(values: readonly T[], value: T): number {
  return values.filter((candidate) => candidate === value).length
}

function rateLine(label: string, rate: Rate, suffix = ""): string {
  if (rate.denominator === 0) return `${label}: insufficient data (eligible_denominator=0${suffix})`
  const percentage = ((rate.numerator / rate.denominator) * 100).toFixed(2)
  return `${label}: ${rate.numerator}/${rate.denominator} = ${percentage}% (eligible_denominator=${rate.denominator}${suffix})`
}

function coverageLines(label: string, coverage: Coverage): readonly string[] {
  const suffix = `, distinct_target_cardinality=${coverage.distinctTargets}`
  return [
    rateLine(`${label}_coverage`, { numerator: coverage.hits, denominator: coverage.turns }, suffix),
    rateLine(`${label}_coverage_cardinality_weighted`, { numerator: coverage.hits, denominator: coverage.distinctTargets }, suffix),
  ]
}

function fixtureBaseRate(question: "category" | "subagent"): FixtureBaseRate {
  const counts = new Map<string, number>()
  for (const fixture of INTENT_ROUTING_FIXTURES) {
    const choice = fixture.label[question]
    counts.set(choice, (counts.get(choice) ?? 0) + 1)
  }
  const majority = [...counts.entries()].sort(([leftChoice, leftCount], [rightChoice, rightCount]) =>
    rightCount - leftCount || leftChoice.localeCompare(rightChoice)
  )[0]
  if (majority === undefined) return { choice: "none", numerator: 0, denominator: 0 }
  return {
    choice: majority[0],
    numerator: majority[1],
    denominator: INTENT_ROUTING_FIXTURES.length,
  }
}

function fixtureBaseRateLine(label: string, rate: FixtureBaseRate): string {
  if (rate.denominator === 0) return `${label}: insufficient data`
  const percentage = ((rate.numerator / rate.denominator) * 100).toFixed(2)
  return `${label}: ${rate.choice} ${rate.numerator}/${rate.denominator} = ${percentage}%`
}

function noneRates(items: readonly AnalyzedRecord[]): Readonly<{ recall: Rate; precision: Rate }> {
  const eligible = items.filter(isRateEligible)
  const actualNone = eligible.filter((item) => item.knownRoutes.size === 0 && !item.hasUnknown)
  const predictedNone = eligible.filter((item) => item.predictedRoute === "none")
  const isValidNone = (item: AnalyzedRecord): boolean => item.answers?.category.valid === true &&
    item.answers.subagent.valid && item.coherent && item.predictedRoute === "none" &&
    item.knownRoutes.size === 0 && !item.hasUnknown
  return {
    recall: { numerator: actualNone.filter(isValidNone).length, denominator: actualNone.length },
    precision: { numerator: predictedNone.filter(isValidNone).length, denominator: predictedNone.length },
  }
}

function denominatorLines(
  observations: readonly IntentRoutingObservationRecord[],
  analyzed: readonly AnalyzedRecord[],
  readResult: ReturnType<typeof readIntentRoutingSink>,
): readonly string[] {
  const { counters } = readResult
  const sealedBy = observations.map((record) => record.sealedBy)
  const statuses = observations.map((record) => record.predictionStatus)
  const correlations = observations.map((record) => record.correlationStatus)
  const sealed = observations.length
  const sealedAtSnapshot = Math.max(
    0,
    counters.recordsCreated - counters.recordsEvicted - counters.recordsInFlight,
  )
  const rowsAfterSnapshot = Math.max(0, sealed - sealedAtSnapshot)
  const inFlight = Math.max(0, counters.recordsInFlight - rowsAfterSnapshot)
  const rowFloor = sealed + counters.recordsEvicted + inFlight
  const recordsCreated = Math.max(counters.recordsCreated, rowFloor)
  const reconciliation = recordsCreated > counters.recordsCreated
    ? `counter_reconciliation: records_created snapshot(${counters.recordsCreated}) raised to row_floor(${rowFloor})`
    : "counter_reconciliation: none"
  const identityTotal = sealed + counters.recordsEvicted + inFlight
  const identity = recordsCreated === identityTotal
    ? `identity: records_created(${recordsCreated}) == sealed(${sealed}) + evicted(${counters.recordsEvicted}) + in_flight(${inFlight})`
    : `identity: MISMATCH records_created(${recordsCreated}) != sealed(${sealed}) + evicted(${counters.recordsEvicted}) + in_flight(${inFlight}) = ${identityTotal}`

  return [
    "DENOMINATORS",
    `turns_seen: ${counters.turnsSeen}`,
    `turns_gated_out: ${counters.turnsGatedOut}`,
    `turns_synthetic: ${counters.turnsSynthetic}`,
    `records_created: ${recordsCreated}`,
    `records_with_prediction: ${analyzed.filter((item) => item.answers !== null).length}`,
    ...SEALED_BY_VALUES.map((value) => `records_sealed_by_${value}: ${countBy(sealedBy, value)}`),
    `records_sealed: ${sealed}`,
    `records_evicted: ${counters.recordsEvicted}`,
    `records_in_flight: ${inFlight}`,
    `orphan_observations: ${counters.orphanObservations}`,
    `unscorable_resume_calls: ${counters.unscorableResumeCalls}`,
    `resume_only_records: ${analyzed.filter((item) => item.resumeOnly).length}`,
    `unscorable_unknown_calls: ${counters.unscorableUnknownCalls}`,
    `unknown_only_records: ${analyzed.filter((item) => item.unknownOnly).length}`,
    `unrepresentable_route_mismatches: ${analyzed.reduce((sum, item) => sum + item.unknownCalls, 0)}`,
    `dispatches_dropped: ${counters.dispatchesDropped}`,
    `invalid_answers: ${observations.reduce((sum, record) => sum + record.invalidAnswerCount, 0)}`,
    `incoherent_predictions: ${analyzed.filter((item) => item.answers !== null && !item.coherent).length}`,
    `malformed_lines: ${readResult.malformedLines}`,
    `malformed_write_rejections: ${counters.malformedWriteRejections}`,
    `records_lost_to_cap: ${readResult.recordsLostToCap}`,
    `sink_truncations: ${readResult.sinkTruncations}`,
    `prediction_reused: ${observations.filter((record) => record.predictionReused).length}`,
    `truncated_input: ${observations.filter((record) => record.truncatedInput).length}`,
    ...PREDICTION_STATUSES.map((value) => `prediction_status_${value}: ${countBy(statuses, value)}`),
    ...CORRELATION_STATUSES.map((value) => `correlation_status_${value}: ${countBy(correlations, value)}`),
    reconciliation,
    identity,
  ]
}

function disagreementShaLines(items: readonly AnalyzedRecord[]): readonly string[] {
  const recurrence = new Map<string, number>()
  for (const item of items.filter((candidate) => isExactEligible(candidate) && !isRouteCorrect(candidate))) {
    recurrence.set(item.record.promptFullSha256, (recurrence.get(item.record.promptFullSha256) ?? 0) + 1)
  }
  if (recurrence.size === 0) return ["none"]
  return [...recurrence.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sha, count]) => `${sha} count=${count}`)
}

export function generateJevW1Report(root: string): string {
  const readResult = readIntentRoutingSink({ directory: root })
  const observations = readResult.entries.filter((entry): entry is IntentRoutingObservationRecord => entry.kind === "observation")
  const analyzed = observations.map(analyzeRecord)
  const exactEligible = analyzed.filter(isExactEligible)
  const coherence: Rate = { numerator: exactEligible.filter((item) => item.coherent).length, denominator: exactEligible.length }
  const none = noneRates(analyzed)
  const categoryFixtureBaseRate = fixtureBaseRate("category")
  const subagentFixtureBaseRate = fixtureBaseRate("subagent")
  const combinedFixtureBaseRate = {
    choice: categoryFixtureBaseRate.choice === subagentFixtureBaseRate.choice
      ? categoryFixtureBaseRate.choice
      : "mixed",
    numerator: categoryFixtureBaseRate.numerator + subagentFixtureBaseRate.numerator,
    denominator: categoryFixtureBaseRate.denominator + subagentFixtureBaseRate.denominator,
  }
  const lines = [
    ...denominatorLines(observations, analyzed, readResult),
    "",
    "ROUTE AGREEMENT",
    "Eligibility: reliable and filled only. Resume-only, censored, overlap_ambiguous, failed, timeout, and not_dispatched records are excluded.",
    "Unknown routes remain eligible and score as unrepresentable mismatches.",
    rateLine("route_agreement", routeRate(analyzed)),
    rateLine("coherence_rate", coherence),
    `multi_route_turns_coverage_only: ${analyzed.filter((item) => isRateEligible(item) && item.knownRoutes.size >= 2).length}`,
    "",
    "NONE RECALL AND PRECISION",
    rateLine("none_recall", none.recall),
    rateLine("none_precision", none.precision),
    "",
    "PER-QUESTION COVERAGE, NOT AGREEMENT",
    ...coverageLines("category", questionCoverage(analyzed, "category")),
    fixtureBaseRateLine("category_fixture_majority_class_base_rate", categoryFixtureBaseRate),
    ...coverageLines("subagent", questionCoverage(analyzed, "subagent")),
    fixtureBaseRateLine("subagent_fixture_majority_class_base_rate", subagentFixtureBaseRate),
    fixtureBaseRateLine("combined_category_subagent_fixture_majority_class_base_rate", combinedFixtureBaseRate),
    "",
    "FAN-OUT BUCKETS",
    ...FAN_OUT_BUCKETS.map((bucket) => rateLine(`fan_out_${bucket}`, routeRate(analyzed.filter((item) => item.record.fanOutBucket === bucket)))),
    "",
    "SEALED-BY CROSS-TAB",
    ...SEALED_BY_VALUES.map((sealedBy) => rateLine(`sealed_by_${sealedBy}`, routeRate(analyzed.filter((item) => item.record.sealedBy === sealedBy)))),
    "",
    "CONTINUATION CANDIDATE COHORT",
    rateLine("continuation_candidate_true", routeRate(analyzed.filter((item) => item.record.isContinuationCandidate))),
    rateLine("continuation_candidate_false", routeRate(analyzed.filter((item) => !item.record.isContinuationCandidate))),
    "",
    "INTENT AND AMBIGUOUS: FIXTURE-SCORED ONLY, NO LIVE GROUND TRUTH",
    "intent: not scored from the live sink",
    "ambiguous: not scored from the live sink",
    "",
    "LIVE DISAGREEMENT FULL-PROMPT SHA-256 RECURRENCE",
    ...disagreementShaLines(analyzed),
    "",
    "Non-goal: live disagreements are not reproducible because only a 200-char head is retained, so fixture growth is manual. Full-prompt SHA-256 values make recurrence countable.",
    "Ground truth label: observed delegations are attempts captured before execution, not successes.",
  ]
  return `${lines.join("\n")}\n`
}

function reportRoot(args: readonly string[]): string {
  const rootIndex = args.indexOf("--root")
  if (rootIndex === -1) return getIntentRoutingSinkDirectory()
  const root = args[rootIndex + 1]
  if (root === undefined || root.length === 0) throw new ReportArgumentError()
  return root
}

if (import.meta.main) process.stdout.write(generateJevW1Report(reportRoot(process.argv.slice(2))))
