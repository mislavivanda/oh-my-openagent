import { readFile } from "node:fs/promises"

import { isRecord } from "./answer-validation"
import { selectDecisionBackend } from "./backend-selector"
import { CONFIDENCE_THRESHOLD, REQUESTED_MODEL, RequestBudget, createCountingFetch,
  createDetail, createForwardingCountingFetch, runAccuracy, type HarnessArtifact, type HarnessDetail,
  type MutableCounter } from "./completion-continuation-accuracy-harness"
import { decideCompletionContinuation } from "./completion-continuation"
import type { CompletionContinuationFixture } from "./completion-continuation-fixtures"
import type { CompletionContinuationStateInput } from "./completion-continuation-state"
import { buildCompletionContinuationState } from "./completion-continuation-state"
import type { DecisionBackend, DecisionOutcome, DecisionRequest, DecisionUnavailableReason, Questions } from "./types"

export type RealBaselineOptions = {
  readonly apiKey: string
  readonly fixtures: readonly CompletionContinuationFixture[]
  readonly artifactPath: string
  readonly ceiling: number
  readonly timeoutMs: number
  /** Only set by the sandbox probes that exercise this path against a local fake endpoint. */
  readonly baseURL?: string
}

export type RealBaselineResult = {
  readonly artifact: HarnessArtifact
  readonly detail: HarnessDetail
  readonly networkCallCount: number
  readonly reservedCallCount: number
  readonly wallClockMs: number
}

export type MissingKeyProbeResult = {
  readonly reasons: readonly (DecisionUnavailableReason | null)[]
  readonly networkCallCount: number
}

export type RetainedRealBaselineFacts = {
  readonly status: string
  readonly mode: string
  readonly callCount: number
  readonly networkCallCount: number
  readonly callCeiling: number
  readonly questionVersion: number
  readonly resolvedModel: string | null
  readonly completedCount: number
  readonly raw: string
}

/**
 * Reads a retained real baseline so a rerun reports the recorded measurement instead of
 * spending the budget a second time. The in-process ceiling cannot survive a new process,
 * so this on-disk check is what actually bounds total spend across repeated invocations.
 */
export async function readRetainedRealBaseline(path: string): Promise<RetainedRealBaselineFacts | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return null
  const { status, mode, callCount, networkCallCount, callCeiling, questionVersion, resolvedModel } = parsed
  if (typeof status !== "string" || typeof mode !== "string") return null
  if (typeof callCount !== "number" || typeof networkCallCount !== "number") return null
  if (typeof callCeiling !== "number" || typeof questionVersion !== "number") return null
  if (!Array.isArray(parsed.completedFixtureIds)) return null
  return {
    status, mode, callCount, networkCallCount, callCeiling, questionVersion,
    resolvedModel: typeof resolvedModel === "string" ? resolvedModel : null,
    completedCount: parsed.completedFixtureIds.length,
    raw,
  }
}

/** Wraps a backend so token usage and resolved model are captured without touching the decision policy. */
export function createUsageRecordingBackend(delegate: DecisionBackend, detail: HarnessDetail): DecisionBackend {
  return {
    kind: delegate.kind,
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      const outcome = await delegate.decide(request)
      if (outcome.status === "decided") {
        detail.inputTokens += outcome.usage.input_tokens
        detail.outputTokens += outcome.usage.output_tokens
        detail.calls.push({
          resolvedModel: outcome.model,
          inputTokens: outcome.usage.input_tokens,
          outputTokens: outcome.usage.output_tokens,
          backendLatencyMs: outcome.latencyMs,
        })
      }
      return outcome
    },
  }
}

function createRealBackend(options: RealBaselineOptions, counter: MutableCounter): DecisionBackend {
  return selectDecisionBackend(
    { enabled: true, backend: "real", model: REQUESTED_MODEL, timeoutMs: options.timeoutMs },
    { apiKey: options.apiKey, baseURL: options.baseURL, fetch: createForwardingCountingFetch(counter) },
  )
}

/**
 * Runs each fixture at most once against the live endpoint with SDK retries still disabled.
 * A ceiling breach aborts instead of silently capping, and the partial artifact is retained.
 */
export async function runRealCompletionContinuationBaseline(
  options: RealBaselineOptions,
): Promise<RealBaselineResult> {
  const networkCounter: MutableCounter = { value: 0 }
  const detail = createDetail(options.timeoutMs)
  const budget = new RequestBudget(options.ceiling)
  const backend = createUsageRecordingBackend(createRealBackend(options, networkCounter), detail)
  const startedAt = performance.now()
  const artifact: HarnessArtifact = await runAccuracy({
    fixtures: options.fixtures,
    artifactPath: options.artifactPath,
    budget,
    networkCounter,
    mode: "real",
    timeoutMs: options.timeoutMs,
    detail,
    backendFor: () => backend,
  })
  return {
    artifact,
    detail,
    networkCallCount: networkCounter.value,
    reservedCallCount: budget.count,
    wallClockMs: performance.now() - startedAt,
  }
}

/** Proves the no-key path short-circuits: every fixture reports missing_api_key and no request leaves. */
export async function runMissingKeyProbe(
  fixtures: readonly CompletionContinuationFixture[],
  timeoutMs: number,
): Promise<MissingKeyProbeResult> {
  const networkCounter: MutableCounter = { value: 0 }
  const backend = selectDecisionBackend(
    { enabled: true, backend: "real", model: REQUESTED_MODEL, timeoutMs },
    { apiKey: undefined, fetch: createCountingFetch(networkCounter) },
  )
  const reasons: (DecisionUnavailableReason | null)[] = []
  for (const fixture of fixtures) {
    const input: CompletionContinuationStateInput = fixture.input
    const decision = await decideCompletionContinuation({
      backend,
      state: buildCompletionContinuationState(input).state,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      timeoutMs,
      model: REQUESTED_MODEL,
    })
    reasons.push(decision.unavailableReason)
  }
  return { reasons, networkCallCount: networkCounter.value }
}
