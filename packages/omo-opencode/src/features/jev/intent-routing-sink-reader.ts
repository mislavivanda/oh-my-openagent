import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  resolveIntentRoutingCounterDeltas,
  validateIntentRoutingEntry,
  type IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"

import type { IntentRoutingSinkReadResult } from "./intent-routing-sink-contract"

const SINK_FILE_PATTERN = /^w1-\d{8}-.+\.jsonl$/u

export function resolveIntentRoutingSinkRoot(homeDir?: string): string {
  const envHome = process.env.HOME?.trim()
  const resolvedHome = homeDir ?? (envHome && envHome.length > 0 ? envHome : homedir())
  return join(resolvedHome, ".omo", "jev")
}

export function readIntentRoutingEntries(files: readonly string[]): {
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

export function readIntentRoutingSink(
  rootDir = resolveIntentRoutingSinkRoot(),
): IntentRoutingSinkReadResult {
  if (!existsSync(rootDir)) {
    return { entries: [], countersByProcess: new Map(), malformedLines: 0, files: [] }
  }
  const files = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SINK_FILE_PATTERN.test(entry.name))
    .map((entry) => join(rootDir, entry.name))
    .sort()
  const { entries, malformedLines } = readIntentRoutingEntries(files)
  return {
    entries,
    countersByProcess: resolveIntentRoutingCounterDeltas(entries),
    malformedLines,
    files,
  }
}
