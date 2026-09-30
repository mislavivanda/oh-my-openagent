import { homedir } from "os"
import { join } from "path"
import type {
  IntentRoutingCounterDelta,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import { readObservationJsonlFiles } from "./observation-jsonl-files"
import {
  selectLatestIntentRoutingCountersByProcess,
  validateIntentRoutingEntry,
} from "@oh-my-opencode/jev-core"

export type IntentRoutingSinkReadResult = {
  readonly entries: readonly IntentRoutingEntry[]
  readonly observations: readonly IntentRoutingObservationRecord[]
  readonly latestCountersByProcess: ReadonlyMap<string, IntentRoutingCounterDelta>
  readonly malformedLines: number
  readonly recordsLostToCap: number
  readonly sinkTruncations: number
  readonly filesRead: number
}

function emptyResult(): IntentRoutingSinkReadResult {
  return {
    entries: [],
    observations: [],
    latestCountersByProcess: new Map(),
    malformedLines: 0,
    recordsLostToCap: 0,
    sinkTruncations: 0,
    filesRead: 0,
  }
}

function isObservation(
  entry: IntentRoutingEntry,
): entry is IntentRoutingObservationRecord {
  return entry.kind === "observation"
}

export function readIntentRoutingSink(
  rootDir = join(homedir(), ".omo", "jev"),
): IntentRoutingSinkReadResult {
  const corpus = readObservationJsonlFiles(rootDir, "w1-", validateIntentRoutingEntry)
  if (corpus.filesRead === 0) return emptyResult()
  const entries = corpus.entries

  const latestCountersByProcess = selectLatestIntentRoutingCountersByProcess(entries)
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
    malformedLines: corpus.malformedLines,
    recordsLostToCap,
    sinkTruncations,
    filesRead: corpus.filesRead,
  }
}
