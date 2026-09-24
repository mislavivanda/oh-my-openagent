import { describe, expect, test } from "bun:test"
import { JevConfigSchema, JevWireConfigSchema } from "./jev"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"

const INTENT_ROUTING_DEFAULTS = {
  enabled: false,
  observe_only: true,
  confidence_threshold: 0.8,
  timeout_ms: 2500,
  turn_seal_timeout_ms: 120000,
  max_prompt_chars: 8000,
  max_inflight: 8,
}

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
        intent_routing: INTENT_ROUTING_DEFAULTS,
      },
    })
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

describe("JevIntentRoutingWireConfigSchema", () => {
  test("#given an empty object #when parsed #then the intent-routing wire is off and observe-only", () => {
    // given
    const input = {}

    // when
    const result = JevConfigSchema.parse(input)

    // then
    expect(result.wires.intent_routing.enabled).toBe(false)
    expect(result.wires.intent_routing.observe_only).toBe(true)
  })

  test("#given observe_only set to false #when parsed #then it throws naming the wire not yet implemented", () => {
    // given
    const input = { wires: { intent_routing: { observe_only: false } } }

    // when
    const parse = () => JevConfigSchema.parse(input)

    // then
    expect(parse).toThrow(/not yet implemented/i)
  })

  test("#given the shared wire schema #when its shape is read #then W4 keys are untouched", () => {
    // given
    const shape = JevWireConfigSchema.shape

    // when
    const keys = Object.keys(shape).sort()

    // then
    expect(keys).toEqual(["confidence_threshold", "enabled"])
  })

  test("#given an empty object #when parsed #then the seal timeout defaults to 120000 and outlasts the prediction timeout", () => {
    // given
    const input = {}

    // when
    const wire = JevConfigSchema.parse(input).wires.intent_routing

    // then
    expect(wire.turn_seal_timeout_ms).toBe(120000)
    expect(wire.timeout_ms).toBe(2500)
    expect(wire.turn_seal_timeout_ms).toBeGreaterThan(wire.timeout_ms)
  })

  test("#given a seal timeout at or below the prediction timeout #when safe-parsed #then the ordering refine rejects it", () => {
    // given
    const equal = { wires: { intent_routing: { timeout_ms: 5000, turn_seal_timeout_ms: 5000 } } }
    const inverted = { wires: { intent_routing: { timeout_ms: 5000, turn_seal_timeout_ms: 1000 } } }

    // when
    const equalResult = JevConfigSchema.safeParse(equal)
    const invertedResult = JevConfigSchema.safeParse(inverted)

    // then
    expect(equalResult.success).toBe(false)
    expect(invertedResult.success).toBe(false)
  })

  test("#given a valid seal timeout above the prediction timeout #when safe-parsed #then it is accepted", () => {
    // given
    const input = { wires: { intent_routing: { timeout_ms: 5000, turn_seal_timeout_ms: 5001 } } }

    // when
    const result = JevConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(true)
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
