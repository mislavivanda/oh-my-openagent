import { validateIntentRoutingEntry } from "@oh-my-opencode/jev-core"
import type { IntentRoutingEntry } from "@oh-my-opencode/jev-core"
import {
  appendObservationJsonlLine,
  ensureObservationJsonlDirectory,
  observationJsonlFileSize,
  readObservationJsonlFile,
  replaceObservationJsonlFile,
  serializeObservationJsonlLine,
} from "./observation-jsonl-files"

export function ensureIntentRoutingSinkDirectory(rootDir: string): void {
  ensureObservationJsonlDirectory(rootDir)
}

export function intentRoutingSinkFileSize(path: string): number {
  return observationJsonlFileSize(path)
}

export function appendIntentRoutingSinkLine(path: string, line: string): void {
  appendObservationJsonlLine(path, line)
}

export function serializeIntentRoutingEntry(
  entry: IntentRoutingEntry,
  maxLineBytes: number,
): string | null {
  return serializeObservationJsonlLine(entry, validateIntentRoutingEntry, maxLineBytes)
}

export function countIntentRoutingObservations(path: string): number {
  return readObservationJsonlFile(path, validateIntentRoutingEntry).entries
    .filter((entry) => entry.kind === "observation")
    .length
}

export function replaceIntentRoutingSinkFile(
  path: string,
  lines: readonly string[],
): void {
  replaceObservationJsonlFile(path, lines)
}
