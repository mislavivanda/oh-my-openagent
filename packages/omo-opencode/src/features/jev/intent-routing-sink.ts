import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import {
  INTENT_ROUTING_SCHEMA_VERSION,
  validateIntentRoutingEntry,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"

import { log } from "../../shared/logger"
import {
  EMPTY_INTENT_ROUTING_COUNTERS,
  INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS,
  INTENT_ROUTING_SINK_MAX_LINE_BYTES,
  INTENT_ROUTING_SINK_SIZE_CAP_BYTES,
  IntentRoutingSinkConfigurationError,
  type IntentRoutingIntervalHandle,
  type IntentRoutingSink,
  type IntentRoutingSinkOptions,
} from "./intent-routing-sink-contract"
import {
  readIntentRoutingEntries,
  resolveIntentRoutingSinkRoot,
} from "./intent-routing-sink-reader"

const PROCESS_START_EPOCH_NANOS = Math.max(
  0,
  Math.trunc((Date.now() - process.uptime() * 1000) * 1_000_000),
).toString()

function defaultScheduleInterval(
  callback: () => void,
  intervalMs: number,
): IntentRoutingIntervalHandle {
  const timer = setInterval(callback, intervalMs)
  timer.unref()
  return { cancel: () => clearInterval(timer) }
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "")
}

export function createIntentRoutingProcessId(input: {
  readonly pid?: number
  readonly processStartEpochNanos?: string
  readonly randomSuffix?: string
} = {}): string {
  const pid = input.pid ?? process.pid
  const start = input.processStartEpochNanos ?? PROCESS_START_EPOCH_NANOS
  const suffix = input.randomSuffix ?? randomUUID().replaceAll("-", "").slice(0, 12)
  if (!Number.isSafeInteger(pid) || pid < 0 || !/^\d+$/u.test(start) || !/^[a-z\d]+$/iu.test(suffix)) {
    throw new IntentRoutingSinkConfigurationError("Intent-routing process identity contains unsafe path characters")
  }
  return `${pid}-${start}-${suffix}`
}

export function createIntentRoutingSink(options: IntentRoutingSinkOptions = {}): IntentRoutingSink {
  const now = options.now ?? (() => new Date())
  const processId = options.processId ?? createIntentRoutingProcessId()
  if (!/^[a-z\d._-]+$/iu.test(processId)) {
    throw new IntentRoutingSinkConfigurationError("Intent-routing processId contains unsafe path characters")
  }
  const maxLineBytes = options.maxLineBytes ?? INTENT_ROUTING_SINK_MAX_LINE_BYTES
  const sizeCapBytes = options.sizeCapBytes ?? INTENT_ROUTING_SINK_SIZE_CAP_BYTES
  const counterIntervalMs = options.counterIntervalMs ?? INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS
  if (maxLineBytes <= 0 || sizeCapBytes < maxLineBytes * 2 || counterIntervalMs <= 0) {
    throw new IntentRoutingSinkConfigurationError("Intent-routing sink bounds must be positive and the cap must hold a row plus its counter")
  }
  const rootDir = resolveIntentRoutingSinkRoot(options.homeDir)
  const filePath = join(rootDir, `w1-${utcDate(now())}-${processId}.jsonl`)
  const warn = options.warn ?? ((message: string, data: Readonly<Record<string, unknown>>) => log(message, data))
  let sourceCounters = { ...EMPTY_INTENT_ROUTING_COUNTERS }
  let epochBase = { ...EMPTY_INTENT_ROUTING_COUNTERS }
  let malformedWriteRejections = 0
  let recordsLostToCap = 0
  let sinkTruncations = 0
  let counterEpoch = 0
  let monotonicSeq = 0
  let disposed = false
  let hasWritableState = false

  const getCounters = (): IntentRoutingCounters => ({
    turnsSeen: Math.max(0, sourceCounters.turnsSeen - epochBase.turnsSeen),
    turnsGatedOut: Math.max(0, sourceCounters.turnsGatedOut - epochBase.turnsGatedOut),
    turnsSynthetic: Math.max(0, sourceCounters.turnsSynthetic - epochBase.turnsSynthetic),
    recordsCreated: Math.max(0, sourceCounters.recordsCreated - epochBase.recordsCreated),
    recordsEvicted: Math.max(0, sourceCounters.recordsEvicted - epochBase.recordsEvicted),
    orphanObservations: Math.max(0, sourceCounters.orphanObservations - epochBase.orphanObservations),
    unscorableResumeCalls: Math.max(0, sourceCounters.unscorableResumeCalls - epochBase.unscorableResumeCalls),
    unscorableUnknownCalls: Math.max(0, sourceCounters.unscorableUnknownCalls - epochBase.unscorableUnknownCalls),
    dispatchesDropped: Math.max(0, sourceCounters.dispatchesDropped - epochBase.dispatchesDropped),
    malformedWriteRejections: Math.max(
      0,
      sourceCounters.malformedWriteRejections - epochBase.malformedWriteRejections,
    ) + malformedWriteRejections,
    recordsLostToCap: sourceCounters.recordsLostToCap + recordsLostToCap,
    sinkTruncations: sourceCounters.sinkTruncations + sinkTruncations,
  })
  const safeWarn = (message: string, data: Readonly<Record<string, unknown>>): void => {
    try {
      warn(message, data)
    } catch (error) {
      if (error instanceof Error) void error.message
      else void String(error)
    }
  }
  const ensureRoot = (): void => {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
    chmodSync(rootDir, 0o700)
  }
  const appendRaw = (line: string): void => {
    ensureRoot()
    appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 })
    chmodSync(filePath, 0o600)
  }
  const currentSize = (): number => existsSync(filePath) ? statSync(filePath).size : 0
  const counterEntry = (): IntentRoutingCounterDelta => ({
    kind: "counter_delta",
    schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
    recordedAt: now().toISOString(),
    processId,
    counterEpoch,
    monotonicSeq,
    counters: getCounters(),
  })
  const emitResetCounter = (): void => {
    monotonicSeq += 1
    appendRaw(`${JSON.stringify(counterEntry())}\n`)
  }
  const truncate = (nextEntry: IntentRoutingEntry): void => {
    const lost = existsSync(filePath) ? readIntentRoutingEntries([filePath]).entries.filter(
      (entry) => entry.kind === "observation",
    ).length : 0
    recordsLostToCap += lost
    sinkTruncations += 1
    counterEpoch += 1
    malformedWriteRejections = 0
    epochBase = { ...sourceCounters }
    if (nextEntry.kind === "observation") {
      epochBase.recordsCreated = Math.max(0, epochBase.recordsCreated - 1)
      epochBase.turnsSeen = Math.max(0, epochBase.turnsSeen - 1)
    }
    ensureRoot()
    writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 })
    chmodSync(filePath, 0o600)
    safeWarn("[jev] intent-routing sink truncated", {
      filePath,
      sizeCapBytes,
      recordsLost: lost,
      counterEpoch,
    })
    emitResetCounter()
  }
  const writeEntry = (entry: IntentRoutingEntry): boolean => {
    const withEpoch: IntentRoutingEntry = entry.kind === "observation"
      ? { ...entry, counterEpoch }
      : { ...entry, processId, counterEpoch, counters: getCounters() }
    let line = `${JSON.stringify(withEpoch)}\n`
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      malformedWriteRejections += 1
      return false
    }
    if (currentSize() + Buffer.byteLength(line, "utf8") > sizeCapBytes) {
      truncate(withEpoch)
      if (entry.kind === "counter_delta") return true
      line = `${JSON.stringify({ ...withEpoch, counterEpoch })}\n`
    }
    appendRaw(line)
    return true
  }
  const flushCounters = (): void => {
    if (!hasWritableState) return
    monotonicSeq += 1
    writeEntry(counterEntry())
  }
  const interval = (options.scheduleInterval ?? defaultScheduleInterval)(() => {
    try {
      flushCounters()
    } catch (error) {
      safeWarn("[jev] intent-routing counter flush failed", {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
    }
  }, counterIntervalMs)

  return {
    processId,
    filePath,
    append: (entry) => {
      if (!validateIntentRoutingEntry(entry)) {
        malformedWriteRejections += 1
        hasWritableState = true
        return false
      }
      hasWritableState = true
      if (entry.kind === "counter_delta") {
        if (entry.processId !== processId) {
          malformedWriteRejections += 1
          return false
        }
        sourceCounters = { ...entry.counters }
        monotonicSeq = Math.max(monotonicSeq, entry.monotonicSeq)
      }
      return writeEntry(entry)
    },
    updateCounters: (counters) => {
      sourceCounters = { ...counters }
      hasWritableState = hasWritableState || Object.values(counters).some((value) => value > 0)
    },
    flushCounters,
    getCounters,
    getCounterEpoch: () => counterEpoch,
    dispose: () => {
      if (disposed) return
      disposed = true
      interval.cancel()
      flushCounters()
    },
  }
}

export {
  INTENT_ROUTING_SINK_ASSUMED_TURNS_PER_DAY,
  INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES,
  INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS,
  INTENT_ROUTING_SINK_MAX_LINE_BYTES,
  INTENT_ROUTING_SINK_RETENTION_DAYS,
  INTENT_ROUTING_SINK_SIZE_CAP_BYTES,
  IntentRoutingSinkConfigurationError,
} from "./intent-routing-sink-contract"
export type {
  IntentRoutingIntervalHandle,
  IntentRoutingSink,
  IntentRoutingSinkOptions,
  IntentRoutingSinkReadResult,
} from "./intent-routing-sink-contract"
export { readIntentRoutingSink } from "./intent-routing-sink-reader"
