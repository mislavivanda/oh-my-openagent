import { randomBytes } from "crypto"

export type ObservationProcessIdentity = {
  readonly pid: number
  readonly processStartEpochNanos: string
  readonly randomSuffix: string
}

export type ObservationProcessIdentitySource = {
  readonly pid: number
  readonly epochMilliseconds: number
  readonly uptimeSeconds: number
  readonly randomSuffix: string
}

export function createObservationProcessIdentity(
  source: ObservationProcessIdentitySource = {
    pid: process.pid,
    epochMilliseconds: Date.now(),
    uptimeSeconds: process.uptime(),
    randomSuffix: randomBytes(6).toString("hex"),
  },
): ObservationProcessIdentity {
  const epochMilliseconds = source.epochMilliseconds - (source.uptimeSeconds * 1000)
  return {
    pid: source.pid,
    processStartEpochNanos: BigInt(Math.floor(epochMilliseconds * 1_000_000)).toString(),
    randomSuffix: source.randomSuffix,
  }
}

export function observationProcessId(identity: ObservationProcessIdentity): string {
  return `${identity.pid}-${identity.processStartEpochNanos}-${identity.randomSuffix}`
}
