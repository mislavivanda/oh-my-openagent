import type { NoulQuestion, Questions } from "./types"

export const COMPLETION_CONTINUATION_QUESTION_VERSION = 1

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
    instructions: `Estimate whether the tracked work is progressing. ${INDEPENDENT_PROBABILITY_NOTE}`,
    criteria: {
      true: "Todo or boulder completion advanced, tracked status changed, or the work became complete.",
      false: "A continuation was followed by known incomplete state with no tracked progress.",
    },
  },
  stuck: {
    type: "noul",
    instructions: `Estimate whether the tracked work is stuck. ${INDEPENDENT_PROBABILITY_NOTE}`,
    criteria: {
      true: "A successful continuation reached another idle point while known incomplete tracked state stayed unchanged.",
      false: "Tracked work progressed or became complete.",
    },
  },
} as const satisfies CompletionContinuationQuestions & Questions
