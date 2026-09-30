import { describe, expect, test } from "bun:test"

import {
  captureInertTrace,
  type InertBackendMode,
} from "./completion-continuation-inert-fixture"
import {
  InertTraceMismatchError,
  assertExistingTrace,
  perturbOrder,
  perturbPayload,
  splitOwnedTrace,
  type InertTraceEntry,
} from "./completion-continuation-inert-trace"

const BACKEND_MODES: readonly InertBackendMode[] = [
  "success",
  "sync-throw",
  "rejection",
  "timeout",
]

function observeExpectedFailure(label: string, callback: () => void): string {
  try {
    callback()
  } catch (error) {
    if (!(error instanceof InertTraceMismatchError)) throw error
    const firstLine = error.message.split("\n")[0] ?? error.message
    console.log(`ANTI_VACUITY_${label}=FAIL_DETECTED ${firstLine}`)
    return firstLine
  }
  throw new TypeError(`${label} perturbation did not fail`)
}

describe("completion-continuation Part A inert proof", () => {
  test("keeps nonempty pre-existing bytes identical under all four backend modes", async () => {
    for (const mode of BACKEND_MODES) {
      const disabled = splitOwnedTrace(await captureInertTrace(false, mode))
      const enabled = splitOwnedTrace(await captureInertTrace(true, mode))

      expect(disabled.existing.length).toBeGreaterThan(10)
      expect(disabled.existing.map((entry) => entry[1])).toEqual(expect.arrayContaining([
        "handler_return", "event_mutation", "completion_detector", "semantic_branch",
        "state_before", "state_after", "toast", "prompt", "setInterval", "setTimeout",
        "clearInterval", "clearTimeout",
      ]))
      expect(disabled.removed).toEqual([])
      expect(enabled.removed.length).toBeGreaterThan(5)
      expect(() => assertExistingTrace(disabled.existing, enabled.existing)).not.toThrow()
      console.log(`PART_A_MODE=${mode} TRACE_COUNT=${enabled.existing.length}`)
      console.log(JSON.stringify(enabled.existing))
      console.log(`PART_A_W2_REMOVED_${mode}=${JSON.stringify(enabled.removed.map((entry) => entry[1]))}`)
    }
  })

  test("fails on prompt bytes, countdown delay, side-effect order, or W2 ownership leakage", async () => {
    const disabled = splitOwnedTrace(await captureInertTrace(false, "success")).existing
    const enabled = splitOwnedTrace(await captureInertTrace(true, "success")).existing

    const failures = [
      observeExpectedFailure("PROMPT_BYTE", () => assertExistingTrace(disabled, perturbPayload(enabled, "prompt", "x"))),
      observeExpectedFailure("COUNTDOWN_DELAY", () => assertExistingTrace(disabled, perturbPayload(enabled, "setTimeout", ":2001"))),
      observeExpectedFailure("SIDE_EFFECT_ORDER", () => assertExistingTrace(disabled, perturbOrder(enabled, "toast", "setInterval"))),
      observeExpectedFailure("W2_OWNED_INJECTION", () => {
        const leaked: readonly InertTraceEntry[] = [...enabled, ["w2", "backend_call", "injected"]]
        assertExistingTrace(disabled, leaked)
      }),
    ]

    expect(failures).toHaveLength(4)
    expect(() => assertExistingTrace(disabled, enabled)).not.toThrow()
    console.log("ANTI_VACUITY_PART_A_REVERT=PASS intended trace restored")
  })
})
