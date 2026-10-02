import type { CompletionContinuationPreviousState } from "@oh-my-opencode/jev-core"
import type { CompletionContinuationOutcomeStore } from "./completion-continuation-outcome-types"

const FIRST_IDLE_PREVIOUS = {
  available: false,
  reason: "first_idle",
} as const satisfies CompletionContinuationPreviousState

export function readCompletionContinuationPreviousState(
  outcomes: CompletionContinuationOutcomeStore,
  sessionID: string,
): CompletionContinuationPreviousState {
  let predecessor: ReturnType<CompletionContinuationOutcomeStore["getLatestPreviousSnapshot"]>
  try {
    predecessor = outcomes.getLatestPreviousSnapshot(sessionID)
  } catch {
    return FIRST_IDLE_PREVIOUS
  }
  if (predecessor === undefined) return FIRST_IDLE_PREVIOUS

  const todos = predecessor.snapshot.input.todos
  const boulder = predecessor.snapshot.input.boulder
  return {
    available: true,
    todoStatusDigest: predecessor.snapshot.inputDigests.todoStatus,
    boulderDigest: predecessor.snapshot.inputDigests.boulder,
    todo: {
      total: todos.length,
      completed: todos.filter((todo) => todo.status === "completed").length,
    },
    boulder: boulder === null
      ? null
      : {
        total: boulder.total,
        completed: boulder.completed,
        remaining: boulder.remaining,
      },
    continuationDispatched: predecessor.continuationDispatched,
  }
}
