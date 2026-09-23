import { describe, expect, test } from "bun:test"
import { isRecord, validateAnswer, validateAnswers } from "./answer-validation"
import type { ChoiceQuestion, DecisionOutcome, Questions, ScoreQuestion } from "./types"

const choiceQuestion = {
  type: "choice",
  instructions: "Choose the next action",
  criteria: {
    retry: "Try again",
    stop: "Do not retry",
    ignore: "Continue without retrying",
  },
} satisfies ChoiceQuestion

const scoreQuestion = {
  type: "score",
  instructions: "Rate the sentiment",
  criteria: ["Calm", "Frustrated", "Very angry"],
} satisfies ScoreQuestion

const validChoiceAnswer = {
  type: "choice",
  choice: "retry",
  confidence: 0.9,
  probabilities: { retry: 0.9, stop: 0.05, ignore: 0.05 },
}

const validScoreAnswer = {
  type: "score",
  score: 1.6,
  confidence: 0.8,
  legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" },
  probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 },
}

const someQuestions = {
  triage: choiceQuestion,
  certainty: {
    type: "noul",
    instructions: "Is the decision certain?",
  },
  sentiment: scoreQuestion,
} satisfies Questions

const invalidChoiceAnswers: ReadonlyArray<readonly [string, unknown]> = [
  ["unknown choice", { ...validChoiceAnswer, choice: "later" }],
  [
    "missing probability key",
    { ...validChoiceAnswer, probabilities: { retry: 0.9, stop: 0.1 } },
  ],
  [
    "extra probability key",
    {
      ...validChoiceAnswer,
      probabilities: { retry: 0.85, stop: 0.05, ignore: 0.05, later: 0.05 },
    },
  ],
  [
    "non-numeric probability",
    { ...validChoiceAnswer, probabilities: { retry: "0.9", stop: 0.05, ignore: 0.05 } },
  ],
  [
    "non-finite probability",
    { ...validChoiceAnswer, probabilities: { retry: Number.NaN, stop: 0.5, ignore: 0.5 } },
  ],
  [
    "probability 1.2",
    { ...validChoiceAnswer, probabilities: { retry: 1.2, stop: -0.1, ignore: -0.1 } },
  ],
  ["confidence 1.5", { ...validChoiceAnswer, confidence: 1.5 }],
  ["non-finite confidence", { ...validChoiceAnswer, confidence: Number.POSITIVE_INFINITY }],
  ["empty probabilities record", { ...validChoiceAnswer, probabilities: {} }],
  ["probabilities array", { ...validChoiceAnswer, probabilities: [] }],
  [
    "probabilities sum 3",
    { ...validChoiceAnswer, probabilities: { retry: 1, stop: 1, ignore: 1 } },
  ],
  [
    "probabilities sum 0.98",
    { ...validChoiceAnswer, probabilities: { retry: 0.33, stop: 0.33, ignore: 0.32 } },
  ],
  [
    "choice is not the argmax",
    {
      ...validChoiceAnswer,
      choice: "stop",
      probabilities: { retry: 0.9, stop: 0.05, ignore: 0.05 },
    },
  ],
]

const invalidScoreAnswers: ReadonlyArray<readonly [string, unknown]> = [
  ["score legend is null", { ...validScoreAnswer, legend: null }],
  ["score legend is missing key 2", { ...validScoreAnswer, legend: { 0: "Calm", 1: "Frustrated" } }],
  [
    "score legend description is wrong",
    { ...validScoreAnswer, legend: { 0: "Calm", 1: "WRONG", 2: "Very angry" } },
  ],
  [
    "score has an extra probability key",
    { ...validScoreAnswer, probabilities: { 0: 0.05, 1: 0.25, 2: 0.65, 3: 0.05 } },
  ],
  [
    "score has a non-numeric probability",
    { ...validScoreAnswer, probabilities: { 0: "0.05", 1: 0.3, 2: 0.65 } },
  ],
  [
    "score has an out-of-range probability",
    { ...validScoreAnswer, probabilities: { 0: -0.1, 1: 0.45, 2: 0.65 } },
  ],
  [
    "score probabilities do not sum to one",
    { ...validScoreAnswer, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1 } },
  ],
  ["score confidence 1.5", { ...validScoreAnswer, confidence: 1.5 }],
  ["score -0.5", { ...validScoreAnswer, score: -0.5 }],
  ["score 2.5", { ...validScoreAnswer, score: 2.5 }],
  ["score is non-finite", { ...validScoreAnswer, score: Number.NaN }],
  ["score 0.2 is inconsistent with weighted level 1.6", { ...validScoreAnswer, score: 0.2 }],
]

describe("isRecord", () => {
  test("#given a plain object #when checking the value #then it is a record", () => {
    expect(isRecord({ answer: true })).toBe(true)
  })

  test.each([
    ["null", null],
    ["an array", []],
  ])("#given %s #when checking the value #then it is not a record", (_name, value) => {
    expect(isRecord(value)).toBe(false)
  })
})

describe("validateAnswer", () => {
  test("#given a well-formed choice #when validating #then it is accepted", () => {
    expect(validateAnswer(choiceQuestion, validChoiceAnswer)).toBe(true)
  })

  test.each(invalidChoiceAnswers)(
    "#given %s #when validating a choice #then it is rejected",
    (_name, answer) => {
      expect(validateAnswer(choiceQuestion, answer)).toBe(false)
    },
  )

  test.each([
    ["probabilities sum 0.99", { retry: 0.33, stop: 0.33, ignore: 0.33 }],
    ["probabilities sum 1.01", { retry: 0.34, stop: 0.34, ignore: 0.33 }],
  ])("#given %s #when validating a choice #then the tolerance boundary is accepted", (_name, probabilities) => {
    expect(validateAnswer(choiceQuestion, { ...validChoiceAnswer, probabilities })).toBe(true)
  })

  test("#given tied maximum probabilities #when validating the selected choice #then the tie is accepted", () => {
    const answer = {
      ...validChoiceAnswer,
      confidence: 0.5,
      probabilities: { retry: 0.5, stop: 0.5, ignore: 0 },
    }

    expect(validateAnswer(choiceQuestion, answer)).toBe(true)
  })

  test("#given noul 0.5 #when validating #then it is accepted", () => {
    expect(validateAnswer(someQuestions.certainty, { type: "noul", noul: 0.5 })).toBe(true)
  })

  test.each([
    ["noul -0.1", -0.1],
    ["non-finite noul", Number.NaN],
  ])("#given %s #when validating #then it is rejected", (_name, noul) => {
    expect(validateAnswer(someQuestions.certainty, { type: "noul", noul })).toBe(false)
  })

  test("#given score 1.6 with its weighted probabilities #when validating #then the between-level score is accepted", () => {
    expect(validateAnswer(scoreQuestion, validScoreAnswer)).toBe(true)
  })

  test.each(invalidScoreAnswers)(
    "#given %s #when validating a score #then it is rejected",
    (_name, answer) => {
      expect(validateAnswer(scoreQuestion, answer)).toBe(false)
    },
  )
})

describe("validateAnswers", () => {
  test("#given every requested answer and an extra field #when validating #then requested answers are accepted", () => {
    const raw = {
      triage: validChoiceAnswer,
      certainty: { type: "noul", noul: 0.75 },
      sentiment: validScoreAnswer,
      metadata: "ignored",
    }

    expect(validateAnswers(someQuestions, raw)).toBe(true)
  })

  test("#given one requested answer is missing #when validating #then the answer map is rejected", () => {
    const raw = {
      triage: validChoiceAnswer,
      certainty: { type: "noul", noul: 0.75 },
    }

    expect(validateAnswers(someQuestions, raw)).toBe(false)
  })
})

function compileGuardedOutcome(raw: unknown): DecisionOutcome<typeof someQuestions> {
  if (!validateAnswers(someQuestions, raw)) {
    return { status: "unavailable", reason: "malformed_response", latencyMs: 0 }
  }

  return {
    status: "decided",
    answers: raw,
    model: "compile-only",
    usage: { input_tokens: 0, output_tokens: 0 },
    latencyMs: 0,
  }
}

void compileGuardedOutcome
