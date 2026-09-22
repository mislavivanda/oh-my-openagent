import { describe, expect, test } from "bun:test"
import { JevConfigSchema } from "./jev"
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
      wires: { model_error_triage: { enabled: false, confidence_threshold: 0.8 } },
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
