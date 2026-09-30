import { randomUUID } from "crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { validateIntentRoutingEntry } from "@oh-my-opencode/jev-core"
import type { IntentRoutingEntry } from "@oh-my-opencode/jev-core"

export function ensureIntentRoutingSinkDirectory(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  chmodSync(rootDir, 0o700)
}

export function intentRoutingSinkFileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function appendIntentRoutingSinkLine(path: string, line: string): void {
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 })
  chmodSync(path, 0o600)
}

export function serializeIntentRoutingEntry(
  entry: IntentRoutingEntry,
  maxLineBytes: number,
): string | null {
  if (!validateIntentRoutingEntry(entry)) return null
  try {
    const line = `${JSON.stringify(entry)}\n`
    return Buffer.byteLength(line) <= maxLineBytes ? line : null
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

export function countIntentRoutingObservations(path: string): number {
  if (!existsSync(path)) return 0
  let count = 0
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (validateIntentRoutingEntry(parsed) && parsed.kind === "observation") count += 1
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return count
}

export function replaceIntentRoutingSinkFile(
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
