import { join } from "path"
import {
  validateCompletionContinuationEntry,
  type CompletionContinuationCounters,
  type CompletionContinuationEntry,
  type CompletionContinuationObservation,
} from "@oh-my-opencode/jev-core"
import { log } from "../../shared"
import {
  beginCompletionContinuationCounterEpoch,
  createCompletionContinuationSinkCounterState,
  discardRetainedCompletionContinuationObservation,
  ingestCompletionContinuationCounterDelta,
  nextCompletionContinuationCounterDelta,
  recordCompletionContinuationMalformedWrite,
  recordCompletionContinuationObservation,
} from "./completion-continuation-sink-counters"
import {
  appendObservationJsonlLine,
  ensureObservationJsonlDirectory,
  observationJsonlFileSize,
  readObservationJsonlFile,
  replaceObservationJsonlFile,
  serializeObservationJsonlLine,
} from "./observation-jsonl-files"
import {
  createObservationProcessIdentity,
  observationProcessId,
  type ObservationProcessIdentity,
} from "./observation-process-identity"

export const DEFAULT_COMPLETION_CONTINUATION_COUNTER_FLUSH_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES = 64 * 1024
export const DEFAULT_COMPLETION_CONTINUATION_SINK_SIZE_CAP_BYTES = 32 * 1024 * 1024

export type CompletionContinuationProcessIdentity = ObservationProcessIdentity

export type CompletionContinuationSinkOptions = {
  readonly rootDir: string
  readonly now?: () => number
  readonly processIdentity?: CompletionContinuationProcessIdentity
  readonly counterFlushIntervalMs?: number
  readonly maxLineBytes?: number
  readonly sizeCapBytes?: number
  readonly getCounters?: () => CompletionContinuationCounters
  readonly onWarning?: (message: string, details: Readonly<Record<string, unknown>>) => void
}

export type CompletionContinuationSink = {
  readonly processId: string
  readonly path: string
  append(entry: unknown): boolean
  flushCounters(): void
  counterIntervalHasRef(): boolean
  dispose(): void
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function dateStamp(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().slice(0, 10).replaceAll("-", "")
}

function withCurrentEpoch(
  entry: CompletionContinuationEntry,
  counterEpoch: number,
): CompletionContinuationEntry {
  switch (entry.kind) {
    case "observation": return { ...entry, counterEpoch }
    case "counter_delta": return { ...entry, counterEpoch }
  }
}

export function createCompletionContinuationSink(
  options: CompletionContinuationSinkOptions,
): CompletionContinuationSink {
  const now = options.now ?? Date.now
  const identity = options.processIdentity ?? createObservationProcessIdentity()
  const processId = observationProcessId(identity)
  const path = join(options.rootDir, `w2-${dateStamp(now())}-${processId}.jsonl`)
  const maxLineBytes = positiveInteger(
    options.maxLineBytes,
    DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES,
  )
  const sizeCapBytes = positiveInteger(
    options.sizeCapBytes,
    DEFAULT_COMPLETION_CONTINUATION_SINK_SIZE_CAP_BYTES,
  )
  const flushIntervalMs = positiveInteger(
    options.counterFlushIntervalMs,
    DEFAULT_COMPLETION_CONTINUATION_COUNTER_FLUSH_INTERVAL_MS,
  )
  const warn = options.onWarning ?? ((message, details) => log(message, details))
  const counters = createCompletionContinuationSinkCounterState(processId, now, options.getCounters)
  let disposed = false
  let flushing = false
  let disposeRequested = false

  ensureObservationJsonlDirectory(options.rootDir)

  function serialize(entry: CompletionContinuationEntry): string | null {
    return serializeObservationJsonlLine(
      entry,
      validateCompletionContinuationEntry,
      maxLineBytes,
    )
  }

  function rejectMalformedWrite(): false {
    recordCompletionContinuationMalformedWrite(counters)
    return false
  }

  function countObservations(): number {
    return readObservationJsonlFile(path, validateCompletionContinuationEntry).entries
      .filter((entry) => entry.kind === "observation")
      .length
  }

  function atomicTruncate(current: CompletionContinuationObservation | undefined): void {
    const lost = countObservations()
    beginCompletionContinuationCounterEpoch(counters, lost, current === undefined ? 0 : 1)
    const lines: string[] = []
    if (current !== undefined) {
      const retained = serialize({ ...current, counterEpoch: counters.epoch })
      if (retained !== null) lines.push(retained)
    }
    let delta = serialize(nextCompletionContinuationCounterDelta(counters))
    if (delta === null) throw new TypeError("Completion-continuation counter line exceeds maxLineBytes")
    const retainedBytes = lines.reduce((total, line) => total + Buffer.byteLength(line), 0)
    if (retainedBytes + Buffer.byteLength(delta) > sizeCapBytes) {
      discardRetainedCompletionContinuationObservation(counters)
      lines.length = 0
      delta = serialize(nextCompletionContinuationCounterDelta(counters))
      if (delta === null) throw new TypeError("Completion-continuation counter line exceeds maxLineBytes")
    }
    lines.push(delta)
    replaceObservationJsonlFile(path, lines)
    warn("[jev] completion-continuation sink truncated at size cap", {
      path,
      sizeCapBytes,
      counterEpoch: counters.epoch,
      recordsLostToCap: counters.recordsLostToCap,
    })
  }

  function appendValidated(entry: CompletionContinuationEntry): boolean {
    const normalized = withCurrentEpoch(entry, counters.epoch)
    const line = serialize(normalized)
    if (line === null) return rejectMalformedWrite()
    switch (normalized.kind) {
      case "observation": recordCompletionContinuationObservation(counters); break
      case "counter_delta": ingestCompletionContinuationCounterDelta(counters, normalized); break
    }
    if (observationJsonlFileSize(path) + Buffer.byteLength(line) > sizeCapBytes) {
      atomicTruncate(normalized.kind === "observation" ? normalized : undefined)
      return true
    }
    appendObservationJsonlLine(path, line)
    return true
  }

  function flushCounters(): void {
    if (disposed || flushing) return
    flushing = true
    try {
      const line = serialize(nextCompletionContinuationCounterDelta(counters))
      if (line === null) throw new TypeError("Completion-continuation counter line exceeds maxLineBytes")
      if (observationJsonlFileSize(path) + Buffer.byteLength(line) > sizeCapBytes) {
        atomicTruncate(undefined)
      } else {
        appendObservationJsonlLine(path, line)
      }
    } finally {
      flushing = false
      if (disposeRequested) disposed = true
    }
  }

  const interval = setInterval(() => {
    try {
      flushCounters()
    } catch (error) { // no-excuse-ok: catch
      warn("[jev] completion-continuation counter flush failed", { error: String(error) })
    }
  }, flushIntervalMs)
  interval.unref()

  return {
    processId,
    path,
    append: (entry) => {
      if (disposed || !validateCompletionContinuationEntry(entry)) return rejectMalformedWrite()
      return appendValidated(entry)
    },
    flushCounters,
    counterIntervalHasRef: () => interval.hasRef(),
    dispose: () => {
      if (disposed || disposeRequested) return
      disposeRequested = true
      clearInterval(interval)
      if (flushing) return
      flushCounters()
      disposed = true
    },
  }
}
