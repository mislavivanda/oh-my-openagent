import { describe, expect, test } from "bun:test"
import { readCompletionContinuationAnswer } from "./completion-continuation-answer-observation"
import {
  type CompletionContinuationClock,
  decideCompletionContinuation,
} from "./completion-continuation"
import { COMPLETION_CONTINUATION_QUESTIONS } from "./completion-continuation-questions"
import { buildCompletionContinuationState } from "./completion-continuation-state"
import type {
  DecisionBackend,
  DecisionOutcome,
  DecisionRequest,
  DecisionUnavailableReason,
  Questions,
} from "./types"

const STATE = buildCompletionContinuationState({
  todos: [{ id: "todo-1", status: "in_progress", content: "Implement the decision policy" }],
  transcript: [],
  diff: null,
  boulder: null,
}).state
const THRESHOLD = 0.8
const FALSE_BOUNDARY = 1 - THRESHOLD
const INERT_CLOCK: CompletionContinuationClock = {
  now: () => 0,
  schedule: () => ({ cancel: () => undefined }),
}
function noul(noul: number) {
  return { type: "noul", noul } as const
}

function validAnswers(values = [0.8123456789012345, 0.1, 0.5] as const) {
  return {
    actually_complete: noul(values[0]),
    progressing: noul(values[1]),
    stuck: noul(values[2]),
  }
}
function createRawBackend(answers: unknown, model = "jev-resolved-v2"): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return JSON.parse(JSON.stringify({
        status: "decided",
        answers,
        model,
        usage: { input_tokens: 3, output_tokens: 3 },
        latencyMs: 7,
      }))
    },
  }
}
function createUnavailableBackend(reason: DecisionUnavailableReason): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
      return { status: "unavailable", reason, latencyMs: 4 }
    },
  }
}
function decide(backend: DecisionBackend, clock = INERT_CLOCK) {
  return decideCompletionContinuation({
    backend,
    state: STATE,
    confidenceThreshold: 0.8,
    timeoutMs: 2_500,
    clock,
  })
}

describe("decideCompletionContinuation", () => {
  test("#given three calibrated answers #when deciding #then one backend call carries all questions and preserves raw probabilities", async () => {
    let calls = 0
    let questionKeys: string[] = []
    const delegate = createRawBackend(validAnswers())
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
        calls += 1
        questionKeys = Object.keys(request.questions)
        return delegate.decide(request)
      },
    }

    const result = await decide(backend)

    expect(calls).toBe(1)
    expect(questionKeys).toEqual(["actually_complete", "progressing", "stuck"])
    expect(result.probabilities).toEqual({
      actuallyComplete: 0.8123456789012345,
      progressing: 0.1,
      stuck: 0.5,
    })
    expect(result.thresholdLabels).toEqual({
      actuallyComplete: "would_true",
      progressing: "would_false",
      stuck: "uncertain",
    })
    expect(result).toMatchObject({
      predictionStatus: "filled",
      unavailableReason: null,
      resolvedModel: "jev-resolved-v2",
      invalidAnswerCount: 0,
    })
    expect("apply" in result || "recommendation" in result || "decision" in result).toBe(false)
  })

  test.each([
    [THRESHOLD, "would_true"],
    [THRESHOLD + Number.EPSILON, "would_true"],
    [THRESHOLD - Number.EPSILON, "uncertain"],
    [FALSE_BOUNDARY + Number.EPSILON, "uncertain"],
    [FALSE_BOUNDARY, "would_false"],
    [FALSE_BOUNDARY - Number.EPSILON, "would_false"],
  ] as const)(
    "#given probability %p #when labeling at threshold 0.8 #then the exact boundary policy returns %s",
    (probability, expected) => {
      const observed = readCompletionContinuationAnswer(
        COMPLETION_CONTINUATION_QUESTIONS.actually_complete,
        noul(probability),
        0.8,
      )
      expect(observed).toEqual({ probability, valid: true, label: expected })
    },
  )

  test.each([
    ["missing noul", { type: "noul" }],
    ["probability string", { type: "noul", noul: "0.9" }],
    ["NaN probability", { type: "noul", noul: Number.NaN }],
    ["probability below zero", { type: "noul", noul: -0.01 }],
    ["probability above one", { type: "noul", noul: 1.01 }],
    ["null answer", null],
    ["empty answer", {}],
  ])("#given %s #when observing the answer #then it is invalid and unavailable", (_name, raw) => {
    const observed = readCompletionContinuationAnswer(
      COMPLETION_CONTINUATION_QUESTIONS.actually_complete,
      raw,
      0.8,
    )
    expect(observed).toEqual({ probability: null, valid: false, label: "unavailable" })
  })

  test.each([
    ["a missing question key", { progressing: noul(0.9), stuck: noul(0.1) }, 1],
    ["an extra question key", { ...validAnswers(), unexpected: noul(0.9) }, 1],
    ["a probability string", { ...validAnswers(), stuck: { type: "noul", noul: "0.5" } }, 1],
    ["a probability below zero", { ...validAnswers(), progressing: noul(-0.01) }, 1],
    ["a probability above one", { ...validAnswers(), progressing: noul(1.01) }, 1],
    ["a null answer", { ...validAnswers(), actually_complete: null }, 1],
    ["an empty answer object", {}, 3],
    ["only two well-formed answers", { actually_complete: noul(0.9), progressing: noul(0.9) }, 1],
  ] as const)("#given %s #when deciding #then the result records malformed-response failure", async (_name, answers, invalidCount) => {
    const result = await decide(createRawBackend(answers))

    expect(result).toMatchObject({
      predictionStatus: "failed",
      unavailableReason: "malformed_response",
      invalidAnswerCount: invalidCount,
    })
  })

  test("#given a NaN answer from an untrusted backend #when deciding #then the result records it as invalid and unavailable", async () => {
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        const outcome = JSON.parse(JSON.stringify({
          status: "decided", answers: validAnswers(), model: "mock",
          usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 1,
        }))
        outcome.answers.stuck.noul = Number.NaN
        return outcome
      },
    }

    const result = await decide(backend)

    expect(result.thresholdLabels.stuck).toBe("unavailable")
    expect(result.probabilities.stuck).toBeNull()
    expect(result).toMatchObject({ predictionStatus: "failed", unavailableReason: "malformed_response" })
  })

  test("#given a backend that never resolves #when the injected clock fires #then timeout is deterministic", async () => {
    let now = 0
    const clock: CompletionContinuationClock = {
      now: () => now,
      schedule: (delayMs, callback) => {
        let active = true
        queueMicrotask(() => {
          if (active) {
            now += delayMs
            callback()
          }
        })
        return { cancel: () => { active = false } }
      },
    }
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        return new Promise(() => undefined)
      },
    }

    const result = await decide(backend, clock)

    expect(result).toMatchObject({ predictionStatus: "timeout", unavailableReason: "timeout", latencyMs: 2_500 })
  })

  test("#given disabled and unavailable backends #when deciding #then each returns a typed failure", async () => {
    const disabled = await decide({ kind: "disabled", decide: () => Promise.reject(new TypeError("must not call")) })
    const unavailable = await decide(createUnavailableBackend("missing_api_key"))

    expect(disabled).toMatchObject({ predictionStatus: "failed", unavailableReason: "disabled" })
    expect(unavailable).toMatchObject({ predictionStatus: "failed", unavailableReason: "missing_api_key" })
  })

  test("maps a rejecting backend to transport failure without throwing", async () => {
    let unhandledRejections = 0
    const onUnhandledRejection = () => { unhandledRejections += 1 }
    process.on("unhandledRejection", onUnhandledRejection)
    try {
      const result = await decide({
        kind: "mock",
        decide: () => Promise.reject(new TypeError("Connection failed")),
      })
      await Promise.resolve()
      expect(result).toMatchObject({ predictionStatus: "failed", unavailableReason: "transport_error" })
      expect(unhandledRejections).toBe(0)
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })

  test("#given a synchronously throwing backend #when deciding #then transport failure is returned", async () => {
    const backend: DecisionBackend = {
      kind: "mock",
      decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        throw new TypeError("Synchronous backend failure")
      },
    }

    const result = await decide(backend)
    expect(result).toMatchObject({
      predictionStatus: "failed",
      unavailableReason: "transport_error",
    })
  })
})
