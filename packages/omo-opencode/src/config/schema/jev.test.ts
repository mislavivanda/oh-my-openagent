import { describe, expect, test } from "bun:test"
import {
  JevCompletionContinuationWireConfigSchema,
  JevConfigSchema,
  JevIntentRoutingWireConfigSchema,
  JevWireConfigSchema,
} from "./jev"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"

describe("JevConfigSchema", () => {
  test("#given an empty object #when parsed #then every field falls back to the default-off shape", () => {
    // given
    const input = {}

    // when
    const result = JevConfigSchema.parse(input)

    // then
    expect(result).toEqual({
      enabled: false,
      backend: "real",
      model: "jev-latest",
      timeout_ms: 1500,
      wires: {
        model_error_triage: { enabled: false, confidence_threshold: 0.8 },
        intent_routing: {
          enabled: false,
          observe_only: true,
          confidence_threshold: 0.8,
          timeout_ms: 2500,
          turn_seal_timeout_ms: 120000,
          max_prompt_chars: 8000,
          max_inflight: 8,
        },
        completion_continuation: {
          enabled: false,
          observe_only: true,
          confidence_threshold: 0.8,
          timeout_ms: 2500,
          outcome_window_ms: 120000,
          max_inflight: 8,
          max_state_bytes: 24576,
        },
      },
    })
  })

  test("#given apply mode #when parsed #then it is rejected as not yet implemented", () => {
    // given
    const input = { wires: { intent_routing: { observe_only: false } } }

    // when / then
    expect(() => JevConfigSchema.parse(input)).toThrow(/not yet implemented/i)
  })

  test("#given the shared wire schema #when its shape is inspected #then it remains limited to W4 fields", () => {
    // given
    const sharedWireSchema = JevWireConfigSchema

    // when
    const keys = Object.keys(sharedWireSchema.shape)

    // then
    expect(keys).toEqual(["enabled", "confidence_threshold"])
  })

  test("#given default intent-routing timeouts #when parsed #then the seal timeout is longer than prediction", () => {
    // given
    const input = {}

    // when
    const result = JevConfigSchema.parse(input)

    // then
    expect(result.wires.intent_routing.turn_seal_timeout_ms).toBe(120000)
    expect(result.wires.intent_routing.turn_seal_timeout_ms).toBeGreaterThan(result.wires.intent_routing.timeout_ms)
  })

  test("#given equal or shorter turn-seal timeouts #when parsed #then both orderings are rejected", () => {
    // given
    const equalTimeouts = { wires: { intent_routing: { timeout_ms: 2500, turn_seal_timeout_ms: 2500 } } }
    const shorterSealTimeout = { wires: { intent_routing: { timeout_ms: 2500, turn_seal_timeout_ms: 2499 } } }

    // when / then
    expect(() => JevConfigSchema.parse(equalTimeouts)).toThrow()
    expect(() => JevConfigSchema.parse(shorterSealTimeout)).toThrow()
  })

  test("#given an unknown backend #when safe-parsed #then it is rejected", () => {
    // given
    const input = { backend: "nope" }

    // when
    const result = JevConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given an out-of-range timeout #when safe-parsed #then it is rejected at both bounds", () => {
    // given
    const tooSmall = { timeout_ms: 50 }
    const tooLarge = { timeout_ms: 30001 }

    // when
    const smallResult = JevConfigSchema.safeParse(tooSmall)
    const largeResult = JevConfigSchema.safeParse(tooLarge)

    // then
    expect(smallResult.success).toBe(false)
    expect(largeResult.success).toBe(false)
  })

  test("#given a confidence threshold above 1 #when safe-parsed #then the wire is rejected", () => {
    // given
    const input = { wires: { model_error_triage: { confidence_threshold: 1.5 } } }

    // when
    const result = JevConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })
})

describe("JevCompletionContinuationWireConfigSchema", () => {
  test("#given an empty wire object #when parsed #then the W2 wire is off and observe-only", () => {
    // given
    const input = {}

    // when
    const result = JevCompletionContinuationWireConfigSchema.parse(input)

    // then
    expect(result.enabled).toBe(false)
    expect(result.observe_only).toBe(true)
  })

  test("#given the W2 wire schema #when its shape is inspected #then it declares exactly the seven planned fields", () => {
    // given
    const wireSchema = JevCompletionContinuationWireConfigSchema

    // when
    const keys = Object.keys(wireSchema.shape)

    // then
    expect(keys).toEqual([
      "enabled",
      "observe_only",
      "confidence_threshold",
      "timeout_ms",
      "outcome_window_ms",
      "max_inflight",
      "max_state_bytes",
    ])
  })

  test("#given default W2 settings #when parsed #then the bounded state cap is 24576 bytes", () => {
    // given
    const input = {}

    // when
    const result = JevConfigSchema.parse(input)

    // then
    expect(result.wires.completion_continuation.max_state_bytes).toBe(24576)
  })

  test("#given W2 apply mode #when parsed #then it is rejected as an unimplemented apply phase", () => {
    // given
    const input = { wires: { completion_continuation: { observe_only: false } } }

    // when / then
    expect(() => JevConfigSchema.parse(input)).toThrow(/not yet implemented|apply phase/i)
  })

  test("#given W2 outcome windows #when parsed #then only a window strictly longer than the timeout is accepted", () => {
    // given
    const equalWindow = { wires: { completion_continuation: { timeout_ms: 2500, outcome_window_ms: 2500 } } }
    const shorterWindow = { wires: { completion_continuation: { timeout_ms: 2500, outcome_window_ms: 2499 } } }
    const longerWindow = { wires: { completion_continuation: { timeout_ms: 2500, outcome_window_ms: 2501 } } }

    // when / then
    expect(() => JevConfigSchema.parse(equalWindow)).toThrow(/outcome_window_ms/)
    expect(() => JevConfigSchema.parse(shorterWindow)).toThrow(/outcome_window_ms/)
    expect(JevConfigSchema.parse(longerWindow).wires.completion_continuation.outcome_window_ms).toBe(2501)
  })

  test("#given malformed or unknown W2 values #when parsed #then violations are rejected and extra keys stripped", () => {
    // given
    const wrongType = { wires: { completion_continuation: { timeout_ms: "fast" } } }
    const negativeWindow = { wires: { completion_continuation: { outcome_window_ms: -1 } } }
    const nullWire = { wires: { completion_continuation: null } }
    const unknownKey = { wires: { completion_continuation: { apply_decisions: true } } }

    // when / then
    expect(JevConfigSchema.safeParse(wrongType).success).toBe(false)
    expect(JevConfigSchema.safeParse(negativeWindow).success).toBe(false)
    expect(JevConfigSchema.safeParse(nullWire).success).toBe(false)
    expect(JevConfigSchema.parse(unknownKey).wires.completion_continuation).not.toHaveProperty("apply_decisions")
  })

  test("#given the W1 wire schema #when its shape is inspected #then the intent-routing fields are unchanged", () => {
    // given
    const w1Schema = JevIntentRoutingWireConfigSchema

    // when
    const keys = Object.keys(w1Schema.shape)

    // then
    expect(keys).toEqual([
      "enabled",
      "observe_only",
      "confidence_threshold",
      "timeout_ms",
      "turn_seal_timeout_ms",
      "max_prompt_chars",
      "max_inflight",
    ])
  })
})

describe("OhMyOpenCodeConfigSchema jev key", () => {
  test("#given a config without jev #when parsed #then jev stays undefined", () => {
    // given
    const input = {}

    // when
    const result = OhMyOpenCodeConfigSchema.parse(input)

    // then
    expect(result.jev).toBeUndefined()
  })

  test("#given jev enabled with no wire settings #when parsed #then the wire stays off", () => {
    // given
    const input = { jev: { enabled: true } }

    // when
    const result = OhMyOpenCodeConfigSchema.parse(input)

    // then
    expect(result.jev?.enabled).toBe(true)
    expect(result.jev?.wires.model_error_triage.enabled).toBe(false)
    expect(result.jev?.wires.model_error_triage.confidence_threshold).toBe(0.8)
  })
})
