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
    expect(COMPLETION_CONTINUATION_QUESTION_VERSION).toBe(1)
  })

  test("#given independent probability questions #when inspecting criteria #then each supports true and false evidence", () => {
    for (const question of Object.values(COMPLETION_CONTINUATION_QUESTIONS)) {
      expect(question.instructions.length).toBeGreaterThan(0)
      expect(question.criteria?.true?.length).toBeGreaterThan(0)
      expect(question.criteria?.false?.length).toBeGreaterThan(0)
    }
  })
})
