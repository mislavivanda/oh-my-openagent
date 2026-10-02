import { describe, expect, test } from "bun:test"
import {
  COMPLETION_CONTINUATION_FIXTURES,
  type CompletionContinuationFixture,
} from "./completion-continuation-fixtures"

function hasCompleteTrackedWork(fixture: CompletionContinuationFixture): boolean {
  const todos = fixture.input.todos
  const boulder = fixture.input.boulder
  const todosComplete = todos !== undefined
    && todos.length > 0
    && todos.every((todo) => todo.status === "completed")
  const boulderComplete = boulder !== undefined
    && boulder !== null
    && boulder.total > 0
    && boulder.remaining === 0
  return todosComplete || boulderComplete
}

function hasKnownIncompleteTrackedWork(fixture: CompletionContinuationFixture): boolean {
  const todos = fixture.input.todos
  const boulder = fixture.input.boulder
  return todos?.some((todo) => todo.status !== "completed") === true
    || (boulder !== undefined && boulder !== null && boulder.total > 0 && boulder.remaining > 0)
}

function hasSuccessfulContinuationThenUnchangedShape(
  fixture: CompletionContinuationFixture,
): boolean {
  return fixture.cohorts.includes("stuck")
}

describe("completion-continuation fixture line-45 consistency", () => {
  test("#given complete tracked work #when line 45 is applied #then progressing is true and stuck is false", () => {
    // given
    const completeFixtures = COMPLETION_CONTINUATION_FIXTURES.filter(hasCompleteTrackedWork)

    // when
    const labels = completeFixtures.map((fixture) => ({ id: fixture.id, label: fixture.label }))

    // then
    expect(labels).toHaveLength(4)
    for (const { id, label } of labels) {
      expect(label.actuallyComplete, id).toBeTrue()
      expect(label.progressing, id).toBeTrue()
      expect(label.stuck, id).toBeFalse()
    }
  })

  test("#given the unchanged-next-idle shape #when stuck labels are audited #then the shape maps exactly to false false true", () => {
    for (const fixture of COMPLETION_CONTINUATION_FIXTURES) {
      // given
      const hasShape = hasSuccessfulContinuationThenUnchangedShape(fixture)

      // when
      const isStuck = fixture.label.stuck === true

      // then
      expect(isStuck, `${fixture.id}: stuck label and outcome shape diverged`).toBe(hasShape)
      if (isStuck) {
        expect(hasKnownIncompleteTrackedWork(fixture), fixture.id).toBeTrue()
        expect(fixture.label.actuallyComplete, fixture.id).toBeFalse()
        expect(fixture.label.progressing, fixture.id).toBeFalse()
      }
    }
  })

  test("#given tracked progress #when stuck is mapped #then progressing true excludes stuck true", () => {
    for (const fixture of COMPLETION_CONTINUATION_FIXTURES) {
      if (fixture.label.progressing === true) {
        expect(fixture.label.stuck, fixture.id).toBeFalse()
      }
    }
  })
})
