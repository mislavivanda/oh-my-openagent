import { describe, expect, test } from "bun:test"
import {
  COMPLETION_CONTINUATION_FIXTURES,
  type CompletionContinuationFixture,
} from "./completion-continuation-fixtures"
import { buildCompletionContinuationState } from "./completion-continuation-state"

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

function trackedWorkBecameComplete(fixture: CompletionContinuationFixture): boolean {
  const previous = fixture.input.previous
  if (previous?.available !== true || !hasCompleteTrackedWork(fixture)) return false
  const previousTodoIncomplete = previous.todo.total > previous.todo.completed
  const previousBoulderIncomplete = previous.boulder !== null
    && previous.boulder.total > 0
    && previous.boulder.remaining > 0
  return previousTodoIncomplete || previousBoulderIncomplete
}

function hasSuccessfulContinuationThenUnchangedIncomplete(
  fixture: CompletionContinuationFixture,
): boolean {
  const previous = fixture.input.previous
  if (previous?.available !== true
    || !previous.continuationDispatched
    || !hasKnownIncompleteTrackedWork(fixture)) return false
  const current = buildCompletionContinuationState(fixture.input).state
  return current.todo.statusDigest === previous.todoStatusDigest
    && current.inputDigests.boulder === previous.boulderDigest
}

describe("completion-continuation fixture line-45 consistency", () => {
  test("#given complete tracked work #when the predecessor is inspected #then only a transition can label progressing true", () => {
    // given
    const completeFixtures = COMPLETION_CONTINUATION_FIXTURES.filter(hasCompleteTrackedWork)

    // when
    const labels = completeFixtures.map((fixture) => ({ id: fixture.id, label: fixture.label }))

    // then
    expect(labels).toHaveLength(4)
    for (const { id, label } of labels) {
      expect(label.actuallyComplete, id).toBeTrue()
      const fixture = completeFixtures.find((candidate) => candidate.id === id)
      if (fixture === undefined) throw new TypeError(`Missing complete fixture ${id}`)
      const expectedProgressing = trackedWorkBecameComplete(fixture) ? true : "unknown"
      expect(label.progressing, id).toBe(expectedProgressing)
      expect(label.stuck, id).toBeFalse()
    }
  })

  test("#given a label claims completion #when no tracked transition exists #then completion does not imply progress", () => {
    for (const fixture of COMPLETION_CONTINUATION_FIXTURES) {
      // given
      const claimsCompletion = fixture.label.actuallyComplete === true

      // when
      const becameComplete = trackedWorkBecameComplete(fixture)

      // then
      if (claimsCompletion && !becameComplete) {
        expect(fixture.label.progressing, fixture.id).toBe("unknown")
      }
    }
  })

  test("#given the unchanged-next-idle shape #when stuck labels are audited #then the shape maps exactly to false false true", () => {
    for (const fixture of COMPLETION_CONTINUATION_FIXTURES) {
      // given
      const hasShape = hasSuccessfulContinuationThenUnchangedIncomplete(fixture)

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
