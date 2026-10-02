import { describe, expect, test } from "bun:test"
import {
  COMPLETION_CONTINUATION_QUESTIONS,
  COMPLETION_CONTINUATION_QUESTION_KEYS,
  COMPLETION_CONTINUATION_QUESTION_VERSION,
} from "./completion-continuation-questions"

describe("completion-continuation questions", () => {
  test("#given the W2 question set #when inspecting its shape #then exactly three named Noul questions are present", () => {
    expect(Object.keys(COMPLETION_CONTINUATION_QUESTIONS)).toEqual([
      "actually_complete",
      "progressing",
      "stuck",
    ])
    expect(COMPLETION_CONTINUATION_QUESTION_KEYS).toEqual([
      "actually_complete",
      "progressing",
      "stuck",
    ])
    expect(Object.values(COMPLETION_CONTINUATION_QUESTIONS).every((question) => question.type === "noul")).toBe(true)
    expect(COMPLETION_CONTINUATION_QUESTION_VERSION).toBe(2)
  })

  test("#given independent probability questions #when inspecting criteria #then each supports true and false evidence", () => {
    for (const question of Object.values(COMPLETION_CONTINUATION_QUESTIONS)) {
      expect(question.instructions.length).toBeGreaterThan(0)
      expect(question.instructions).toContain("independent probability")
      expect(question.instructions).toContain("not a forced single class")
      expect(question.instructions).toContain("high on more than one question or low on all three")
      expect(question.criteria?.true?.length).toBeGreaterThan(0)
      expect(question.criteria?.false?.length).toBeGreaterThan(0)
    }
  })

  test("#given the snapshot-answerable completion question #when inspecting its text #then the version-one wording is unchanged", () => {
    expect(COMPLETION_CONTINUATION_QUESTIONS.actually_complete).toEqual({
      type: "noul",
      instructions: "Estimate whether the tracked work is actually complete. Give an independent probability, not a forced single class. A record may legitimately be high on more than one question or low on all three.",
      criteria: {
        true: "Tracked todos or boulder work are complete, with no remaining required work.",
        false: "Tracked work remains incomplete and continuation activity is still warranted.",
      },
    })
  })

  test("#given the two delta questions #when inspecting their guidance #then both name the current and previous comparison fields", () => {
    const requiredFieldNames = [
      "todo.statusDigest",
      "boulder.total",
      "boulder.completed",
      "boulder.remaining",
      "inputDigests.boulder",
      "previous.todoStatusDigest",
      "previous.boulderDigest",
      "previous.todo.total",
      "previous.todo.completed",
      "previous.boulder.total",
      "previous.boulder.completed",
      "previous.boulder.remaining",
    ]

    for (const key of ["progressing", "stuck"] as const) {
      const question = COMPLETION_CONTINUATION_QUESTIONS[key]
      const guidance = `${question.instructions} ${question.criteria.true} ${question.criteria.false}`
      for (const fieldName of requiredFieldNames) expect(guidance).toContain(fieldName)
    }
    expect(COMPLETION_CONTINUATION_QUESTIONS.stuck.criteria.true).toContain("previous.continuationDispatched")
  })

  test("#given a first-idle state #when inspecting either delta instruction #then absence means no predecessor and calls for a low-confidence middle answer", () => {
    for (const key of ["progressing", "stuck"] as const) {
      const instructions = COMPLETION_CONTINUATION_QUESTIONS[key].instructions
      expect(instructions).toContain("previous.available === false")
      expect(instructions).toContain("no predecessor exists")
      expect(instructions).toContain("not a predecessor with null values")
      expect(instructions).toContain("low confidence near the middle")
      expect(instructions).toContain("rather than guessing true or false")
    }
  })
})
