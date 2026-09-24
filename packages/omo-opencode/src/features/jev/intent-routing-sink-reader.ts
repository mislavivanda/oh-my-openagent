import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  selectLatestCounterDeltasByProcess,
  validateIntentRoutingEntry,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"
import {
  addIntentRoutingCounters,
  createEmptyIntentRoutingCounters,
} from "./intent-routing-sink-counters"

export const INTENT_ROUTING_SINK_MAX_LINE_BYTES = 64 * 1024

export type IntentRoutingSinkReadOptions = Readonly<{
  directory?: string
  maxLineBytes?: number
}>

export type IntentRoutingSinkReadResult = Readonly<{
  entries: readonly IntentRoutingEntry[]
  latestCountersByProcess: ReadonlyMap<string, IntentRoutingCounterDelta>
  counters: IntentRoutingCounters
  malformedLines: number
  recordsLostToCap: number
  sinkTruncations: number
}>

export function getIntentRoutingSinkDirectory(): string {
  return join(homedir(), ".omo", "jev")
}

export function readIntentRoutingSink(
  options: IntentRoutingSinkReadOptions = {},
): IntentRoutingSinkReadResult {
  const directory = options.directory ?? getIntentRoutingSinkDirectory()
  const maxLineBytes = options.maxLineBytes ?? INTENT_ROUTING_SINK_MAX_LINE_BYTES
  const entries: IntentRoutingEntry[] = []
  let malformedLines = 0

  if (existsSync(directory)) {
    const filenames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^w1-\d{8}-.+\.jsonl$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    for (const filename of filenames) {
      const lines = readFileSync(join(directory, filename), "utf8").split("\n")
      for (const line of lines) {
        if (line.length === 0) continue
        if (Buffer.byteLength(`${line}\n`) > maxLineBytes) {
          malformedLines += 1
          continue
        }
        try {
          const parsed: unknown = JSON.parse(line)
          if (validateIntentRoutingEntry(parsed)) entries.push(parsed)
          else malformedLines += 1
        } catch (error) {
          if (error instanceof SyntaxError) {
            malformedLines += 1
            continue
          }
          throw error
        }
      }
    }
  }

  const deltas: IntentRoutingCounterDelta[] = []
  for (const entry of entries) {
    switch (entry.kind) {
      case "observation":
        break
      case "counter_delta":
        deltas.push(entry)
        break
    }
  }
  const latestCountersByProcess = selectLatestCounterDeltasByProcess(deltas)
  const counters = createEmptyIntentRoutingCounters()
  for (const delta of latestCountersByProcess.values()) {
    addIntentRoutingCounters(counters, delta.counters)
  }
  return {
    entries,
    latestCountersByProcess,
    counters,
    malformedLines,
    recordsLostToCap: counters.recordsLostToCap,
    sinkTruncations: counters.sinkTruncations,
  }
}
