import { INTENT_ROUTING_QUESTION_VERSION } from "./intent-routing"
import { INTENT_ROUTING_FIXTURES } from "./intent-routing-accuracy-fixtures"
import type { IntentRoutingFixture } from "./intent-routing-fixtures"
import type {
  DecisionBackend,
  DecisionRequest,
  DecisionUnavailableReason,
  DecisionUsage,
  Questions,
} from "./types"

export const QUESTION_KEYS = ["intent", "category", "subagent", "ambiguous"] as const
export const CHOICE_KEYS = ["intent", "category", "subagent"] as const
export const CALL_CEILING = INTENT_ROUTING_FIXTURES.length
export const MAX_PROMPT_CHARS = 8000

type QuestionKey = (typeof QUESTION_KEYS)[number]
export type HarnessMode = "mock" | "real" | "dry-run"
export type ConfusionMatrix = Record<string, Record<string, number>>
export type ConfusionMatrices = Record<QuestionKey, ConfusionMatrix>

export type FixtureResult = {
  readonly id: string
  readonly status: "filled" | "unavailable" | "invalid"
  readonly resolvedModel: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly usage: DecisionUsage | null
  readonly latencyMs: number | null
}

export type DecisionMeasurement = {
  readonly resolvedModel: string | null
  readonly unavailableReason: DecisionUnavailableReason | null
  readonly usage: DecisionUsage | null
  readonly latencyMs: number
}

export type AccuracyArtifact = {
  readonly status: "complete" | "partial"
  readonly mode: HarnessMode
  readonly resolvedModel: string | null
  readonly questionVersion: number
  readonly callCeiling: number
  readonly builtFixtureIds: readonly string[]
  readonly completedFixtureIds: readonly string[]
  readonly decisionCallCount: number
  readonly networkCallCount: number
  readonly requestCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: { readonly min: number | null; readonly max: number | null }
  readonly unavailableReasonCounts: Readonly<Partial<Record<DecisionUnavailableReason, number>>>
  readonly fixtureResults: readonly FixtureResult[]
  readonly errorName: string | null
  readonly confusionMatrix: ConfusionMatrices
}

export type CallCounter = {
  readonly read: () => number
  readonly increment: () => void
}

export type HarnessOptions = {
  readonly mode?: HarnessMode
  readonly callCeiling?: number
  readonly backendForFixture?: (fixture: IntentRoutingFixture, index: number) => DecisionBackend
  readonly requestCount?: () => number
}

export class IntentRoutingCallCeilingError extends Error {
  constructor(
    readonly ceiling: number,
    readonly attemptedCall: number,
  ) {
    super(`intent-routing call ceiling ${ceiling} blocks call ${attemptedCall}`)
    this.name = "IntentRoutingCallCeilingError"
  }
}

export class UnexpectedDryRunBackendCallError extends Error {
  constructor() {
    super("dry-run must not resolve or call a backend")
    this.name = "UnexpectedDryRunBackendCallError"
  }
}

export function resolveHarnessMode(argv: readonly string[]): HarnessMode {
  return argv.includes("--dry-run") ? "dry-run" : "mock"
}

export function realApiEnabled(env: {
  readonly JEV_W1_REAL_API?: string
  readonly TYPESAFE_API_KEY?: string
}): boolean {
  return env.JEV_W1_REAL_API === "1" && Boolean(env.TYPESAFE_API_KEY?.trim())
}

export function consumeCall(ceiling: number, counter: CallCounter): void {
  const completedCalls = counter.read()
  if (completedCalls >= ceiling) {
    throw new IntentRoutingCallCeilingError(ceiling, completedCalls + 1)
  }
  counter.increment()
}

export function createMatrices(): ConfusionMatrices {
  return { intent: {}, category: {}, subagent: {}, ambiguous: {} }
}

export function createMeasuredBackend(
  backend: DecisionBackend,
  measurements: DecisionMeasurement[],
): DecisionBackend {
  return {
    kind: backend.kind,
    async decide<Q extends Questions>(request: DecisionRequest<Q>) {
      const outcome = await backend.decide(request)
      measurements.push(
        outcome.status === "decided"
          ? {
              resolvedModel: outcome.model,
              unavailableReason: null,
              usage: outcome.usage,
              latencyMs: outcome.latencyMs,
            }
          : {
              resolvedModel: null,
              unavailableReason: outcome.reason,
              usage: null,
              latencyMs: outcome.latencyMs,
            },
      )
      return outcome
    },
  }
}

export function addObservation(
  matrix: ConfusionMatrix,
  expected: string,
  predicted: string,
): void {
  const row = matrix[expected] ?? {}
  row[predicted] = (row[predicted] ?? 0) + 1
  matrix[expected] = row
}

export function matrixTotal(matrix: ConfusionMatrix): number {
  return Object.values(matrix).reduce(
    (total, row) => total + Object.values(row).reduce((rowTotal, count) => rowTotal + count, 0),
    0,
  )
}

export { INTENT_ROUTING_QUESTION_VERSION }
