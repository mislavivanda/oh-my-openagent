import { describe, expect, test } from "bun:test"

import {
  CALL_CEILING,
  consumeCall,
  IntentRoutingCallCeilingError,
  matrixTotal,
  QUESTION_KEYS,
  resolveHarnessMode,
  UnexpectedDryRunBackendCallError,
  type CallCounter,
} from "./intent-routing-accuracy-contract"
import {
  createFixtureMockBackend,
  INTENT_ROUTING_FIXTURES,
  MOCK_RESOLVED_MODEL,
} from "./intent-routing-accuracy-fixtures"
import { runAccuracyHarness } from "./intent-routing-accuracy-harness"

const ACTIVE_MODE = resolveHarnessMode(Bun.argv)

describe("intent-routing accuracy harness", () => {
  test.skipIf(ACTIVE_MODE === "dry-run")("#given the default mock path #when every fixture is scored #then every question emits a complete confusion matrix with zero network calls", async () => {
    const artifact = await runAccuracyHarness()
    console.info(`mock-accuracy-artifact=${JSON.stringify(artifact)}`)
    console.info(`zero-network-calls=${artifact.networkCallCount}`)

    expect(artifact.status).toBe("complete")
    expect(artifact.completedFixtureIds).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.decisionCallCount).toBe(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.networkCallCount).toBe(0)
    expect(artifact.resolvedModel).toBe(MOCK_RESOLVED_MODEL)
    expect(Object.hasOwn(artifact, "resolvedModel")).toBe(true)
    expect(Object.hasOwn(artifact, "questionVersion")).toBe(true)
    for (const question of QUESTION_KEYS) {
      expect(matrixTotal(artifact.confusionMatrix[question])).toBe(INTENT_ROUTING_FIXTURES.length)
    }
  })

  test("#given --dry-run #when every fixture request is built #then no backend or network call is made", async () => {
    const artifact = await runAccuracyHarness({
      mode: "dry-run",
      backendForFixture: () => {
        throw new UnexpectedDryRunBackendCallError()
      },
    })
    console.info(`dry-run built=${artifact.builtFixtureIds.length} decision-calls=${artifact.decisionCallCount} network-calls=${artifact.networkCallCount}`)

    expect(resolveHarnessMode(["bun", "test", "--dry-run"])).toBe("dry-run")
    expect(artifact.status).toBe("complete")
    expect(artifact.builtFixtureIds).toHaveLength(INTENT_ROUTING_FIXTURES.length)
    expect(artifact.decisionCallCount).toBe(0)
    expect(artifact.networkCallCount).toBe(0)
  })

  test("#given a stub counter one below the ceiling #when two calls are requested #then the second aborts with the named ceiling error", () => {
    let calls = CALL_CEILING - 1
    const counter: CallCounter = {
      read: () => calls,
      increment: () => {
        calls += 1
      },
    }
    consumeCall(CALL_CEILING, counter)

    let thrown: IntentRoutingCallCeilingError | undefined
    try {
      consumeCall(CALL_CEILING, counter)
    } catch (error) {
      if (error instanceof IntentRoutingCallCeilingError) thrown = error
      else throw error
    }

    expect(thrown).toBeInstanceOf(IntentRoutingCallCeilingError)
    expect(thrown?.name).toBe("IntentRoutingCallCeilingError")
    expect(calls).toBe(CALL_CEILING)
    console.info(`ceiling-abort-proof ceiling=${CALL_CEILING} calls=${calls} error=IntentRoutingCallCeilingError`)
  })

  test("#given a failure at fixture 8 #when the run stops #then a partial artifact retains the first 7 fixture ids", async () => {
    const artifact = await runAccuracyHarness({
      mode: "mock",
      backendForFixture: (fixture, index) => (
        index === 7
          ? { kind: "mock", decide: async () => ({ status: "unavailable", reason: "api_error", latencyMs: 1 }) }
          : createFixtureMockBackend(fixture)
      ),
    })
    console.info(`partial-accuracy-artifact=${JSON.stringify(artifact)}`)

    expect(artifact.status).toBe("partial")
    expect(artifact.errorName).toBe("IntentRoutingFixtureError")
    expect(artifact.completedFixtureIds).toEqual(INTENT_ROUTING_FIXTURES.slice(0, 7).map((fixture) => fixture.id))
    expect(artifact.decisionCallCount).toBe(8)
  })
})
