import { decideIntentRouting } from "./intent-routing-decision"
import {
  addObservation,
  CALL_CEILING,
  CHOICE_KEYS,
  consumeCall,
  createMatrices,
  createMeasuredBackend,
  INTENT_ROUTING_QUESTION_VERSION,
  IntentRoutingCallCeilingError,
  MAX_PROMPT_CHARS,
  resolveHarnessMode,
  type AccuracyArtifact,
  type CallCounter,
  type DecisionMeasurement,
  type FixtureResult,
  type HarnessOptions,
} from "./intent-routing-accuracy-contract"
import {
  buildAccuracyRequest,
  createFixtureMockBackend,
  INTENT_ROUTING_FIXTURES,
  VOCABULARY,
} from "./intent-routing-accuracy-fixtures"
import type { DecisionUnavailableReason } from "./types"

export async function runAccuracyHarness(
  options: HarnessOptions = {},
): Promise<AccuracyArtifact> {
  const mode = options.mode ?? resolveHarnessMode(Bun.argv)
  const callCeiling = options.callCeiling ?? CALL_CEILING
  const builtFixtureIds: string[] = []
  const completedFixtureIds: string[] = []
  const fixtureResults: FixtureResult[] = []
  const measurements: DecisionMeasurement[] = []
  const unavailableReasonCounts: Partial<Record<DecisionUnavailableReason, number>> = {}
  const confusionMatrix = createMatrices()
  let decisionCallCount = 0
  let resolvedModel: string | null = null
  const counter: CallCounter = {
    read: () => decisionCallCount,
    increment: () => {
      decisionCallCount += 1
    },
  }
  const artifact = (status: "complete" | "partial", errorName: string | null): AccuracyArtifact => {
    const latencies = measurements.map((measurement) => measurement.latencyMs)
    const requestCount = options.requestCount?.() ?? 0
    return {
      status,
      mode,
      resolvedModel,
      questionVersion: INTENT_ROUTING_QUESTION_VERSION,
      callCeiling,
      builtFixtureIds,
      completedFixtureIds,
      decisionCallCount,
      networkCallCount: requestCount,
      requestCount,
      inputTokens: measurements.reduce(
        (total, measurement) => total + (measurement.usage?.input_tokens ?? 0),
        0,
      ),
      outputTokens: measurements.reduce(
        (total, measurement) => total + (measurement.usage?.output_tokens ?? 0),
        0,
      ),
      latencyMs: {
        min: latencies.length === 0 ? null : Math.min(...latencies),
        max: latencies.length === 0 ? null : Math.max(...latencies),
      },
      unavailableReasonCounts,
      fixtureResults,
      errorName,
      confusionMatrix,
    }
  }

  for (const [index, fixture] of INTENT_ROUTING_FIXTURES.entries()) {
    const request = buildAccuracyRequest(fixture)
    JSON.stringify(request)
    builtFixtureIds.push(fixture.id)
    if (mode === "dry-run") continue

    try {
      consumeCall(callCeiling, counter)
    } catch (error) {
      if (error instanceof IntentRoutingCallCeilingError) return artifact("partial", error.name)
      throw error
    }

    const backend = createMeasuredBackend(
      options.backendForFixture?.(fixture, index) ?? createFixtureMockBackend(fixture),
      measurements,
    )
    const result = await decideIntentRouting({
      backend,
      input: fixture.input,
      vocab: VOCABULARY,
      confidenceThreshold: 0.8,
      model: request.model,
      maxPromptChars: MAX_PROMPT_CHARS,
    })
    if (result.predictionStatus !== "filled" || result.answers === null) {
      const measurement = measurements.at(-1)
      const unavailableReason = result.unavailableReason
      fixtureResults.push({
        id: fixture.id,
        status: "unavailable",
        resolvedModel: null,
        unavailableReason,
        usage: measurement?.usage ?? null,
        latencyMs: result.latencyMs,
      })
      if (unavailableReason !== null) {
        unavailableReasonCounts[unavailableReason] = (unavailableReasonCounts[unavailableReason] ?? 0) + 1
      }
      if (unavailableReason === "missing_api_key") continue
      return artifact("partial", "IntentRoutingFixtureError")
    }

    let valid = true
    for (const key of CHOICE_KEYS) {
      const answer = result.answers[key]
      if (!answer.valid) {
        valid = false
        break
      }
      addObservation(confusionMatrix[key], fixture.label[key], answer.choice)
    }
    if (!valid || !result.answers.ambiguous.valid) {
      const measurement = measurements.at(-1)
      fixtureResults.push({
        id: fixture.id,
        status: "invalid",
        resolvedModel: result.resolvedModel,
        unavailableReason: null,
        usage: measurement?.usage ?? null,
        latencyMs: result.latencyMs,
      })
      return artifact("partial", "IntentRoutingFixtureError")
    }
    addObservation(
      confusionMatrix.ambiguous,
      String(fixture.label.ambiguous),
      String(result.answers.ambiguous.noul >= 0.5),
    )
    resolvedModel = result.resolvedModel
    const measurement = measurements.at(-1)
    fixtureResults.push({
      id: fixture.id,
      status: "filled",
      resolvedModel: result.resolvedModel,
      unavailableReason: null,
      usage: measurement?.usage ?? null,
      latencyMs: result.latencyMs,
    })
    completedFixtureIds.push(fixture.id)
  }
  return artifact("complete", null)
}
