import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type {
  IntentRoutingCounterDelta,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
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
  if (!existsSync(rootDir)) return emptyResult()
  const files = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("w1-") && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
  const entries: IntentRoutingEntry[] = []
  let malformedLines = 0

  for (const file of files) {
    for (const line of readFileSync(join(rootDir, file), "utf8").split("\n")) {
      if (line === "") continue
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
    malformedLines,
    recordsLostToCap,
    sinkTruncations,
    filesRead: files.length,
  }
}
