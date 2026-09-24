import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import {
  resolveIntentRoutingCounterDeltas,
  validateIntentRoutingEntry,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

const SINK_FILE_PATTERN = /^w1-\d{8}-.+\.jsonl$/u
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

export type JevW1Corpus = {
  readonly observations: readonly IntentRoutingObservationRecord[]
  readonly counters: IntentRoutingCounters
  readonly counterProcessSnapshots: number
  readonly malformedLines: number
}

function addCounters(left: IntentRoutingCounters, right: IntentRoutingCounters): IntentRoutingCounters {
  return {
    turnsSeen: left.turnsSeen + right.turnsSeen,
    turnsGatedOut: left.turnsGatedOut + right.turnsGatedOut,
    turnsSynthetic: left.turnsSynthetic + right.turnsSynthetic,
    recordsCreated: left.recordsCreated + right.recordsCreated,
    recordsEvicted: left.recordsEvicted + right.recordsEvicted,
    orphanObservations: left.orphanObservations + right.orphanObservations,
    unscorableResumeCalls: left.unscorableResumeCalls + right.unscorableResumeCalls,
    unscorableUnknownCalls: left.unscorableUnknownCalls + right.unscorableUnknownCalls,
    dispatchesDropped: left.dispatchesDropped + right.dispatchesDropped,
    malformedWriteRejections: left.malformedWriteRejections + right.malformedWriteRejections,
    recordsLostToCap: left.recordsLostToCap + right.recordsLostToCap,
    sinkTruncations: left.sinkTruncations + right.sinkTruncations,
  }
}

export function readJevW1Corpus(root: string): JevW1Corpus {
  if (!existsSync(root)) {
    return { observations: [], counters: EMPTY_COUNTERS, counterProcessSnapshots: 0, malformedLines: 0 }
  }
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SINK_FILE_PATTERN.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort()
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
  const snapshots = resolveIntentRoutingCounterDeltas(entries)
  let counters = EMPTY_COUNTERS
  for (const snapshot of snapshots.values()) counters = addCounters(counters, snapshot.counters)
  return {
    observations: entries.filter((entry): entry is IntentRoutingObservationRecord => entry.kind === "observation"),
    counters,
    counterProcessSnapshots: snapshots.size,
    malformedLines,
  }
}
