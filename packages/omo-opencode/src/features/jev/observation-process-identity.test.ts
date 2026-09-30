/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  createObservationProcessIdentity,
  observationProcessId,
  type ObservationProcessIdentitySource,
} from "./observation-process-identity"

const SOURCE: ObservationProcessIdentitySource = {
  pid: 41,
  epochMilliseconds: 2_000,
  uptimeSeconds: 0.5,
  randomSuffix: "fixed",
}

describe("observation process identity", () => {
  test("#given the same process source #when identities are created #then the process-start identity is stable", () => {
    const first = createObservationProcessIdentity(SOURCE)
    const second = createObservationProcessIdentity(SOURCE)

    expect(first).toEqual(second)
    expect(first.processStartEpochNanos).toBe("1500000000")
    expect(observationProcessId(first)).toBe("41-1500000000-fixed")
  })

  test("#given a different process start #when an identity is created #then its process id changes", () => {
    const first = createObservationProcessIdentity(SOURCE)
    const restarted = createObservationProcessIdentity({
      ...SOURCE,
      epochMilliseconds: SOURCE.epochMilliseconds + 1,
    })

    expect(restarted.processStartEpochNanos).toBe("1501000000")
    expect(observationProcessId(restarted)).not.toBe(observationProcessId(first))
  })
})
