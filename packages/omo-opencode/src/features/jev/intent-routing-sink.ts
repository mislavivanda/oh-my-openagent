import { randomBytes } from "crypto"
import { homedir } from "os"
import { join } from "path"
import {
  validateIntentRoutingEntry,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import { log } from "../../shared"
import {
  beginIntentRoutingCounterEpoch,
  createIntentRoutingSinkCounterState,
  discardRetainedIntentRoutingObservation,
  ingestIntentRoutingCounterDelta,
  nextIntentRoutingCounterDelta,
  recordIntentRoutingMalformedWrite,
  recordIntentRoutingObservation,
} from "./intent-routing-sink-counters"
import {
  appendIntentRoutingSinkLine,
  countIntentRoutingObservations,
  ensureIntentRoutingSinkDirectory,
  intentRoutingSinkFileSize,
  replaceIntentRoutingSinkFile,
  serializeIntentRoutingEntry,
} from "./intent-routing-sink-files"

export const DEFAULT_INTENT_ROUTING_COUNTER_FLUSH_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_INTENT_ROUTING_MAX_LINE_BYTES = 64 * 1024
export const DEFAULT_INTENT_ROUTING_SINK_SIZE_CAP_BYTES = 32 * 1024 * 1024

export type IntentRoutingProcessIdentity = {
  readonly pid: number
  readonly processStartEpochNanos: string
  readonly randomSuffix: string
}

export type IntentRoutingSinkOptions = {
  readonly rootDir?: string
  readonly now?: () => number
  readonly processIdentity?: IntentRoutingProcessIdentity
  readonly counterFlushIntervalMs?: number
  readonly maxLineBytes?: number
  readonly sizeCapBytes?: number
  readonly getCounters?: () => IntentRoutingCounters
  readonly onWarning?: (message: string, details: Readonly<Record<string, unknown>>) => void
}

export type IntentRoutingSink = {
  readonly processId: string
  readonly path: string
  append(entry: unknown): boolean
  flushCounters(): void
  dispose(): void
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function processStartEpochNanos(): string {
  const epochMilliseconds = Date.now() - (process.uptime() * 1000)
  return BigInt(Math.floor(epochMilliseconds * 1_000_000)).toString()
}

function createProcessIdentity(): IntentRoutingProcessIdentity {
  return {
    pid: process.pid,
    processStartEpochNanos: processStartEpochNanos(),
    randomSuffix: randomBytes(6).toString("hex"),
  }
}

function dateStamp(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().slice(0, 10).replaceAll("-", "")
}

function withCurrentEpoch(
  entry: IntentRoutingEntry,
  counterEpoch: number,
): IntentRoutingEntry {
  switch (entry.kind) {
    case "observation": return { ...entry, counterEpoch }
    case "counter_delta": return { ...entry, counterEpoch }
  }
}

/**
 * Stores validated routing entries under the user's home directory.
 * `promptHeadChars` is persisted verbatim. This sink does not scrub secrets.
 */
export function createIntentRoutingSink(
  options: IntentRoutingSinkOptions = {},
): IntentRoutingSink {
  const now = options.now ?? Date.now
  const identity = options.processIdentity ?? createProcessIdentity()
  const processId = `${identity.pid}-${identity.processStartEpochNanos}-${identity.randomSuffix}`
  const rootDir = options.rootDir ?? join(homedir(), ".omo", "jev")
  const path = join(rootDir, `w1-${dateStamp(now())}-${processId}.jsonl`)
  const maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_INTENT_ROUTING_MAX_LINE_BYTES)
  const sizeCapBytes = positiveInteger(options.sizeCapBytes, DEFAULT_INTENT_ROUTING_SINK_SIZE_CAP_BYTES)
  const flushIntervalMs = positiveInteger(
    options.counterFlushIntervalMs,
    DEFAULT_INTENT_ROUTING_COUNTER_FLUSH_INTERVAL_MS,
  )
  const warn = options.onWarning ?? ((message, details) => log(message, details))
  const counters = createIntentRoutingSinkCounterState(processId, now, options.getCounters)
  let disposed = false

  ensureIntentRoutingSinkDirectory(rootDir)

  function rejectMalformedWrite(): false {
    recordIntentRoutingMalformedWrite(counters)
    return false
  }

  function atomicTruncate(current: IntentRoutingObservationRecord | undefined): void {
    const lost = countIntentRoutingObservations(path)
    beginIntentRoutingCounterEpoch(counters, lost, current === undefined ? 0 : 1)
    const lines: string[] = []
    if (current !== undefined) {
      const retained = serializeIntentRoutingEntry(
        { ...current, counterEpoch: counters.epoch },
        maxLineBytes,
      )
      if (retained !== null) lines.push(retained)
    }
    let delta = serializeIntentRoutingEntry(nextIntentRoutingCounterDelta(counters), maxLineBytes)
    if (delta === null) throw new TypeError("Intent-routing counter line exceeds maxLineBytes")
    if (lines.reduce((total, line) => total + Buffer.byteLength(line), Buffer.byteLength(delta)) > sizeCapBytes) {
      discardRetainedIntentRoutingObservation(counters)
      lines.length = 0
      delta = serializeIntentRoutingEntry(nextIntentRoutingCounterDelta(counters), maxLineBytes)
      if (delta === null) throw new TypeError("Intent-routing counter line exceeds maxLineBytes")
    }
    lines.push(delta)
    replaceIntentRoutingSinkFile(path, lines)
    warn("[jev] intent-routing sink truncated at size cap", {
      path,
      sizeCapBytes,
      counterEpoch: counters.epoch,
      recordsLostToCap: counters.recordsLostToCap,
    })
  }

  function appendValidated(entry: IntentRoutingEntry): boolean {
    const normalized = withCurrentEpoch(entry, counters.epoch)
    const line = serializeIntentRoutingEntry(normalized, maxLineBytes)
    if (line === null) return rejectMalformedWrite()
    switch (normalized.kind) {
      case "observation": recordIntentRoutingObservation(counters); break
      case "counter_delta": ingestIntentRoutingCounterDelta(counters, normalized); break
    }
    if (intentRoutingSinkFileSize(path) + Buffer.byteLength(line) > sizeCapBytes) {
      atomicTruncate(normalized.kind === "observation" ? normalized : undefined)
      return true
    }
    appendIntentRoutingSinkLine(path, line)
    return true
  }

  function flushCounters(): void {
    const entry = nextIntentRoutingCounterDelta(counters)
    const line = serializeIntentRoutingEntry(entry, maxLineBytes)
    if (line === null) throw new TypeError("Intent-routing counter line exceeds maxLineBytes")
    if (intentRoutingSinkFileSize(path) + Buffer.byteLength(line) > sizeCapBytes) {
      atomicTruncate(undefined)
      return
    }
    appendIntentRoutingSinkLine(path, line)
  }

  const interval = setInterval(() => {
    try {
      flushCounters()
    } catch (error) {
      warn("[jev] intent-routing counter flush failed", { error: String(error) })
    }
  }, flushIntervalMs)
  interval.unref()

  return {
    processId,
    path,
    append: (entry) => {
      if (disposed || !validateIntentRoutingEntry(entry)) return rejectMalformedWrite()
      return appendValidated(entry)
    },
    flushCounters,
    dispose: () => {
      if (disposed) return
      clearInterval(interval)
      flushCounters()
      disposed = true
    },
  }
}
