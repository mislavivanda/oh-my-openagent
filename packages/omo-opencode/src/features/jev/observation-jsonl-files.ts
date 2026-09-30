import { randomUUID } from "crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { join } from "path"

export type ObservationJsonlValidator<Entry> = (value: unknown) => value is Entry

export type ObservationJsonlFileReadResult<Entry> = {
  readonly entries: readonly Entry[]
  readonly malformedLines: number
}

export type ObservationJsonlFilesReadResult<Entry> = ObservationJsonlFileReadResult<Entry> & {
  readonly filesRead: number
}

export function ensureObservationJsonlDirectory(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  chmodSync(rootDir, 0o700)
}

export function observationJsonlFileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function appendObservationJsonlLine(path: string, line: string): void {
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 })
  chmodSync(path, 0o600)
}

export function serializeObservationJsonlLine<Entry>(
  entry: unknown,
  validate: ObservationJsonlValidator<Entry>,
  maxLineBytes: number,
): string | null {
  if (!validate(entry)) return null
  try {
    const line = `${JSON.stringify(entry)}\n`
    return Buffer.byteLength(line) <= maxLineBytes ? line : null
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

export function readObservationJsonlFile<Entry>(
  path: string,
  validate: ObservationJsonlValidator<Entry>,
): ObservationJsonlFileReadResult<Entry> {
  if (!existsSync(path)) return { entries: [], malformedLines: 0 }
  const entries: Entry[] = []
  let malformedLines = 0
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (validate(parsed)) entries.push(parsed)
      else malformedLines += 1
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      malformedLines += 1
    }
  }
  return { entries, malformedLines }
}

export function readObservationJsonlFiles<Entry>(
  rootDir: string,
  filenamePrefix: string,
  validate: ObservationJsonlValidator<Entry>,
): ObservationJsonlFilesReadResult<Entry> {
  if (!existsSync(rootDir)) return { entries: [], malformedLines: 0, filesRead: 0 }
  const files = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && entry.name.startsWith(filenamePrefix)
      && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
  const entries: Entry[] = []
  let malformedLines = 0
  for (const file of files) {
    const result = readObservationJsonlFile(join(rootDir, file), validate)
    entries.push(...result.entries)
    malformedLines += result.malformedLines
  }
  return { entries, malformedLines, filesRead: files.length }
}

export function replaceObservationJsonlFile(
  path: string,
  lines: readonly string[],
): void {
  const tempPath = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(tempPath, lines.join(""), { encoding: "utf8", mode: 0o600, flag: "wx" })
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath)
    throw error
  }
}
