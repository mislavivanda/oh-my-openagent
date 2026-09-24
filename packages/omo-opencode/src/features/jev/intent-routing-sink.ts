// allow: SIZE_OK - Secure append, epoch reset, cumulative counter translation, and tolerant reads share one on-disk contract.

import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  INTENT_ROUTING_SCHEMA_VERSION,
  resolveIntentRoutingCounterDeltas,
  validateIntentRoutingEntry,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

import { log } from "../../shared/logger"

export const INTENT_ROUTING_SINK_MAX_LINE_BYTES = 16 * 1024
export const INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS = 30_000
export const INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES = 1724
export const INTENT_ROUTING_SINK_ASSUMED_TURNS_PER_DAY = 10_000
export const INTENT_ROUTING_SINK_RETENTION_DAYS = 4
// Rows intentionally persist 200-character prompt heads. This sink does not scrub secrets.
const MEBIBYTE = 1024 * 1024
const BENCHMARK_WINDOW_BYTES = INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES *
  INTENT_ROUTING_SINK_ASSUMED_TURNS_PER_DAY * INTENT_ROUTING_SINK_RETENTION_DAYS
export const INTENT_ROUTING_SINK_SIZE_CAP_BYTES =
  Math.ceil(BENCHMARK_WINDOW_BYTES / MEBIBYTE) * MEBIBYTE

const EMPTY_COUNTERS: IntentRoutingCounters = {
  turnsSeen: 0,
  turnsGatedOut: 0,
  turnsSynthetic: 0,
  recordsCreated: 0,
  recordsEvicted: 0,
  orphanObservations: 0,
  unscorableResumeCalls: 0,
  unscorableUnknownCalls: 0,
  dispatchesDropped: 0,
  malformedWriteRejections: 0,
  recordsLostToCap: 0,
  sinkTruncations: 0,
}
const PROCESS_START_EPOCH_NANOS = Math.max(
  0,
  Math.trunc((Date.now() - process.uptime() * 1000) * 1_000_000),
).toString()
const SINK_FILE_PATTERN = /^w1-\d{8}-.+\.jsonl$/u

export type IntentRoutingIntervalHandle = { readonly cancel: () => void }
export type IntentRoutingSinkOptions = {
  readonly homeDir?: string
  readonly processId?: string
  readonly now?: () => Date
  readonly maxLineBytes?: number
  readonly sizeCapBytes?: number
  readonly counterIntervalMs?: number
  readonly scheduleInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => IntentRoutingIntervalHandle
  readonly warn?: (message: string, data: Readonly<Record<string, unknown>>) => void
}
export type IntentRoutingSink = {
  readonly processId: string
  readonly filePath: string
  readonly append: (entry: IntentRoutingEntry) => boolean
  readonly updateCounters: (counters: IntentRoutingCounters) => void
  readonly flushCounters: () => void
  readonly getCounters: () => IntentRoutingCounters
  readonly getCounterEpoch: () => number
  readonly dispose: () => void
}
export type IntentRoutingSinkReadResult = {
  readonly entries: readonly IntentRoutingEntry[]
  readonly countersByProcess: ReadonlyMap<string, IntentRoutingCounterDelta>
  readonly malformedLines: number
  readonly files: readonly string[]
}

export class IntentRoutingSinkConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntentRoutingSinkConfigurationError"
  }
}

function defaultScheduleInterval(
  callback: () => void,
  intervalMs: number,
): IntentRoutingIntervalHandle {
  const timer = setInterval(callback, intervalMs)
  timer.unref()
  return { cancel: () => clearInterval(timer) }
}

function sinkRoot(homeDir = homedir()): string {
  return join(homeDir, ".omo", "jev")
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

function readEntries(files: readonly string[]): {
  readonly entries: IntentRoutingEntry[]
  readonly malformedLines: number
} {
  const entries: IntentRoutingEntry[] = []
  let malformedLines = 0
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (validateIntentRoutingEntry(parsed)) entries.push(parsed)
        else malformedLines += 1
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        malformedLines += 1
      }
    }
  }
  return { entries, malformedLines }
}

export function readIntentRoutingSink(rootDir = sinkRoot()): IntentRoutingSinkReadResult {
  if (!existsSync(rootDir)) {
    return { entries: [], countersByProcess: new Map(), malformedLines: 0, files: [] }
  }
  const files = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SINK_FILE_PATTERN.test(entry.name))
    .map((entry) => join(rootDir, entry.name))
    .sort()
  const { entries, malformedLines } = readEntries(files)
  return {
    entries,
    countersByProcess: resolveIntentRoutingCounterDeltas(entries),
    malformedLines,
    files,
  }
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
  const rootDir = sinkRoot(options.homeDir)
  const filePath = join(rootDir, `w1-${utcDate(now())}-${processId}.jsonl`)
  const warn = options.warn ?? ((message: string, data: Readonly<Record<string, unknown>>) => log(message, data))
  let sourceCounters = { ...EMPTY_COUNTERS }
  let epochBase = { ...EMPTY_COUNTERS }
  let malformedWriteRejections = 0
  let recordsLostToCap = 0
  let sinkTruncations = 0
  let counterEpoch = 0
  let monotonicSeq = 0
  let disposed = false

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
    const lost = existsSync(filePath) ? readEntries([filePath]).entries.filter(
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
        return false
      }
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
    updateCounters: (counters) => { sourceCounters = { ...counters } },
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
