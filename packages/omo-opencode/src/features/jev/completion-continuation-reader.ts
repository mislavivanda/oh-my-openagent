import type {
  CompletionContinuationCounterDelta,
  CompletionContinuationEntry,
  CompletionContinuationObservation,
} from "@oh-my-opencode/jev-core"
import {
  selectLatestCompletionContinuationCountersByProcess,
  validateCompletionContinuationEntry,
} from "@oh-my-opencode/jev-core"
import {
  readObservationJsonlFiles,
  serializeObservationJsonlLine,
} from "./observation-jsonl-files"
import { DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES } from "./completion-continuation-sink"

export type CompletionContinuationSinkReadResult = {
  readonly entries: readonly CompletionContinuationEntry[]
  readonly observations: readonly CompletionContinuationObservation[]
  readonly latestCountersByProcess: ReadonlyMap<string, CompletionContinuationCounterDelta>
  readonly malformedLines: number
  readonly recordsLostToCap: number
  readonly sinkTruncations: number
  readonly filesRead: number
}

export function readCompletionContinuationSink(
  rootDir: string,
): CompletionContinuationSinkReadResult {
  const corpus = readObservationJsonlFiles(rootDir, "w2-", validateCompletionContinuationEntry)
  const entries = corpus.entries.filter((entry) => serializeObservationJsonlLine(
    entry,
    validateCompletionContinuationEntry,
    DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES,
  ) !== null)
  const oversizedLines = corpus.entries.length - entries.length
  const latestCountersByProcess = selectLatestCompletionContinuationCountersByProcess(entries)
  let recordsLostToCap = 0
  let sinkTruncations = 0
  for (const entry of latestCountersByProcess.values()) {
    recordsLostToCap += entry.counters.recordsLostToCap
    sinkTruncations += entry.counters.sinkTruncations
  }
  return {
    entries,
    observations: entries.filter(isObservation),
    latestCountersByProcess,
    malformedLines: corpus.malformedLines + oversizedLines,
    recordsLostToCap,
    sinkTruncations,
    filesRead: corpus.filesRead,
  }
}

function isObservation(
  entry: CompletionContinuationEntry,
): entry is CompletionContinuationObservation {
  return entry.kind === "observation"
}
