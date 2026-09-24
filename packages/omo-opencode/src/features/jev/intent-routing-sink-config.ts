import { randomBytes } from "crypto"
import { log } from "../../shared"
import {
  getIntentRoutingSinkDirectory,
  INTENT_ROUTING_SINK_MAX_LINE_BYTES,
} from "./intent-routing-sink-reader"

export const INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS = 60_000
/**
 * A representative 200-character observation measured 1,666 bytes and a counter measured 459 bytes.
 * At 2,000 observations plus one counter per minute, expected volume is 3,992,960 bytes per day.
 * The 32 MiB cap therefore holds about 8.4 high-volume days for one process.
 */
export const INTENT_ROUTING_SINK_SIZE_CAP_BYTES = 32 * 1024 * 1024

export type IntentRoutingSinkIdentity = Readonly<{
  pid: number
  processStartEpochNanos: bigint
  randomSuffix: string
}>

export type IntentRoutingSinkTruncation = Readonly<{
  filePath: string
  counterEpoch: number
  recordsLostToCap: number
  sizeCapBytes: number
}>

export type IntentRoutingSinkOptions = Readonly<{
  directory?: string
  identity?: IntentRoutingSinkIdentity
  schemaVersion?: number
  now?: () => Date
  maxLineBytes?: number
  sizeCapBytes?: number
  counterIntervalMs?: number
  onTruncate?: (event: IntentRoutingSinkTruncation) => void
}>

export type ResolvedIntentRoutingSinkOptions = Readonly<{
  directory: string
  processId: string
  schemaVersion: number
  now: () => Date
  maxLineBytes: number
  sizeCapBytes: number
  counterIntervalMs: number
  onTruncate: (event: IntentRoutingSinkTruncation) => void
}>

class IntentRoutingSinkConfigurationError extends Error {
  readonly name = "IntentRoutingSinkConfigurationError"
}

function createDefaultIdentity(): IntentRoutingSinkIdentity {
  const elapsedNanos = BigInt(Math.floor(process.uptime() * 1_000_000_000))
  return {
    pid: process.pid,
    processStartEpochNanos: BigInt(Date.now()) * 1_000_000n - elapsedNanos,
    randomSuffix: randomBytes(8).toString("hex"),
  }
}

export function resolveIntentRoutingSinkOptions(
  options: IntentRoutingSinkOptions,
): ResolvedIntentRoutingSinkOptions {
  const identity = options.identity ?? createDefaultIdentity()
  const maxLineBytes = options.maxLineBytes ?? INTENT_ROUTING_SINK_MAX_LINE_BYTES
  const sizeCapBytes = options.sizeCapBytes ?? INTENT_ROUTING_SINK_SIZE_CAP_BYTES
  const counterIntervalMs = options.counterIntervalMs ?? INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS
  if (
    !Number.isInteger(identity.pid) || identity.pid < 0 ||
    identity.processStartEpochNanos < 0n || !/^[a-zA-Z0-9]+$/.test(identity.randomSuffix) ||
    maxLineBytes < 1 || sizeCapBytes < maxLineBytes * 2 || counterIntervalMs < 1
  ) {
    throw new IntentRoutingSinkConfigurationError("Invalid intent-routing sink configuration")
  }
  return {
    directory: options.directory ?? getIntentRoutingSinkDirectory(),
    processId: `${identity.pid}-${identity.processStartEpochNanos}-${identity.randomSuffix}`,
    schemaVersion: options.schemaVersion ?? 1,
    now: options.now ?? (() => new Date()),
    maxLineBytes,
    sizeCapBytes,
    counterIntervalMs,
    onTruncate: options.onTruncate ?? ((event) => {
      log("[jev] intent-routing sink truncated at size cap", event)
    }),
  }
}
