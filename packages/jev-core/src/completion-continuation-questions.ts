import type { NoulQuestion, Questions } from "./types"

export const COMPLETION_CONTINUATION_QUESTION_VERSION = 3

export const COMPLETION_CONTINUATION_QUESTION_KEYS = [
  "actually_complete",
  "progressing",
  "stuck",
] as const

export type CompletionContinuationQuestionKey =
  (typeof COMPLETION_CONTINUATION_QUESTION_KEYS)[number]

export type CompletionContinuationQuestions = {
  readonly actually_complete: NoulQuestion
  readonly progressing: NoulQuestion
  readonly stuck: NoulQuestion
}

const INDEPENDENT_PROBABILITY_NOTE = "Give an independent probability, not a forced single class. A record may legitimately be high on more than one question or low on all three."
const PREVIOUS_DELTA_NOTE = "When previous.available is true, compare current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining with previous.todoStatusDigest, previous.todo.total, previous.todo.completed, previous.boulderDigest, previous.boulder.total, previous.boulder.completed, and previous.boulder.remaining."
const FIRST_IDLE_NOTE = "If previous.available === false, no predecessor exists; this is not a predecessor with null values. No delta can be observed on this first idle, so give low confidence near the middle rather than guessing true or false."

export const COMPLETION_CONTINUATION_QUESTIONS = {
  actually_complete: {
    type: "noul",
    instructions: `Estimate whether the tracked work is actually complete. ${INDEPENDENT_PROBABILITY_NOTE}`,
    criteria: {
      true: "Tracked todos or boulder work are complete, with no remaining required work.",
      false: "Tracked work remains incomplete and continuation activity is still warranted.",
    },
  },
  progressing: {
    type: "noul",
    instructions: `Estimate whether the tracked work progressed since the previous idle. ${PREVIOUS_DELTA_NOTE} ${FIRST_IDLE_NOTE} ${INDEPENDENT_PROBABILITY_NOTE}`,
    criteria: {
      true: "With previous.available true, todo.completed rose above previous.todo.completed, boulder.completed rose above previous.boulder.completed, todo.statusDigest advanced from previous.todoStatusDigest, inputDigests.boulder advanced from previous.boulderDigest, or tracked work became complete during this interval: previous.todo or previous.boulder showed incomplete tracked work and current todo and boulder show it complete. Being complete in both snapshots with unchanged todo.statusDigest and inputDigests.boulder is not progress.",
      false: "With previous.available true and previous.continuationDispatched true, tracked work remains incomplete and current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining stayed unchanged from previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.",
    },
  },
  stuck: {
    type: "noul",
    instructions: `Estimate whether the tracked work became stuck since the previous idle. ${PREVIOUS_DELTA_NOTE} Use previous.continuationDispatched to decide whether a successful continuation occurred between snapshots; do not infer that precondition from current values. ${FIRST_IDLE_NOTE} ${INDEPENDENT_PROBABILITY_NOTE}`,
    criteria: {
      true: "With previous.available true and previous.continuationDispatched true, tracked work remains incomplete while current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining stayed unchanged from previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.",
      false: "With previous.available true, current values show tracked progress or completion relative to previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.",
    },
  },
} as const satisfies CompletionContinuationQuestions & Questions
