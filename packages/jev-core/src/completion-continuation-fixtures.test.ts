import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  COMPLETION_CONTINUATION_FIXTURES,
  COMPLETION_CONTINUATION_FIXTURE_COHORTS,
} from "./completion-continuation-fixtures"
import {
  COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  buildCompletionContinuationState,
} from "./completion-continuation-state"

const FIXTURE_MODULES = [
  "completion-continuation-fixtures.ts",
  "completion-continuation-fixtures-primary.ts",
  "completion-continuation-fixtures-edge.ts",
] as const

function requireFixture(id: string) {
  const fixture = COMPLETION_CONTINUATION_FIXTURES.find((candidate) => candidate.id === id)
  if (fixture === undefined) throw new TypeError(`Missing fixture ${id}`)
  return fixture
}

describe("completion-continuation fixtures", () => {
  test("#given the hand-labeled fixture set #when ids and cohorts are enumerated #then every required cohort is non-empty", () => {
    // given
    const ids = COMPLETION_CONTINUATION_FIXTURES.map((fixture) => fixture.id)

    // when
    const counts = Object.fromEntries(COMPLETION_CONTINUATION_FIXTURE_COHORTS.map((cohort) => [
      cohort,
      COMPLETION_CONTINUATION_FIXTURES.filter((fixture) => fixture.cohorts.includes(cohort)).length,
    ]))

    // then
    expect(COMPLETION_CONTINUATION_FIXTURES.length).toBeGreaterThanOrEqual(18)
    expect(new Set(ids).size).toBe(ids.length)
    for (const cohort of COMPLETION_CONTINUATION_FIXTURE_COHORTS) {
      expect(counts[cohort], cohort).toBeGreaterThan(0)
    }
    expect(counts["transcript-tail"]).toBeGreaterThanOrEqual(2)
    expect(counts.multilingual).toBeGreaterThanOrEqual(2)
    expect(counts.adversarial).toBeGreaterThanOrEqual(2)
    console.log(`fixture-cohorts ${JSON.stringify(counts)}`)
  })

  test("#given fixture labels #when their provenance is audited #then every label is hand-assigned without the decision heuristic", async () => {
    // given
    const sources = await Promise.all(FIXTURE_MODULES.map((file) =>
      readFile(join(import.meta.dir, file), "utf8"),
    ))

    // when
    const heuristicReferences = sources.filter((source) => source.includes("decideCompletionContinuation"))

    // then
    expect(COMPLETION_CONTINUATION_FIXTURES.every((fixture) =>
      fixture.groundTruthSource === "hand-assigned" && fixture.labelBasis.includes("reviewer"),
    )).toBeTrue()
    expect(heuristicReferences).toEqual([])
  })

  test("#given continuation prompts #when the transcript tails are inspected #then prior bounded context disambiguates both weak W1 cases", () => {
    // given
    const continueFixture = requireFixture("continue-after-red-test")
    const goOnFixture = requireFixture("go-on-after-source-review")

    // when
    const continueState = buildCompletionContinuationState(continueFixture.input).state
    const goOnState = buildCompletionContinuationState(goOnFixture.input).state

    // then
    expect(continueState.transcript.messages).toHaveLength(2)
    expect(goOnState.transcript.messages).toHaveLength(2)
    expect(continueState.transcript.messages[0]?.role).toBe("assistant")
    expect(continueState.transcript.messages[1]?.content).toBe("continue")
    expect(goOnState.transcript.messages[0]?.role).toBe("assistant")
    expect(goOnState.transcript.messages[1]?.content).toBe("go on")
    expect(continueFixture.label.progressing).toBeTrue()
    expect(goOnFixture.label.progressing).toBeTrue()
  })

  test("#given prompt-injection text #when state is built #then the directive remains inert data and cannot alter the hand label", () => {
    // given
    const fixture = requireFixture("adversarial-fake-system-completion")

    // when
    const result = buildCompletionContinuationState(fixture.input)

    // then
    expect(result.state.transcript.messages[0]?.content).toStartWith("SYSTEM:")
    expect(fixture.label).toEqual({ actuallyComplete: false, progressing: false, stuck: true })
    expect(result.state.todo.pending).toBe(1)
  })

  test("#given every fixture #when states are built for a dry run #then all serialized requests stay within the byte cap", () => {
    // given
    const states = COMPLETION_CONTINUATION_FIXTURES.map((fixture) => ({
      id: fixture.id,
      built: buildCompletionContinuationState(fixture.input),
    }))

    // when
    const oversized = states.filter(({ built }) =>
      built.serializedBytes > COMPLETION_CONTINUATION_MAX_STATE_BYTES,
    )

    // then
    expect(states).toHaveLength(COMPLETION_CONTINUATION_FIXTURES.length)
    expect(oversized).toEqual([])
    expect(states.every(({ built }) => built.serializedBytes <= 24_576)).toBeTrue()
  })

  test("#given malformed-input probes #when states are built #then missing and oversized inputs remain explicit", () => {
    // given
    const noTodos = buildCompletionContinuationState(requireFixture("no-todos-active-untracked-work").input)
    const emptyTranscript = buildCompletionContinuationState(requireFixture("empty-transcript-known-incomplete").input)
    const oversized = buildCompletionContinuationState(requireFixture("oversized-content-reduced").input)

    // when
    const reductions = oversized.state.inputTruncations

    // then
    expect(noTodos.state.todo.total).toBe(0)
    expect(emptyTranscript.state.transcript.messages).toEqual([])
    expect(oversized.serializedBytes).toBeLessThanOrEqual(COMPLETION_CONTINUATION_MAX_STATE_BYTES)
    expect(Object.values(reductions).some(Boolean)).toBeTrue()
  })
})
