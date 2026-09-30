/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  appendObservationJsonlLine,
  ensureObservationJsonlDirectory,
  observationJsonlFileSize,
  readObservationJsonlFile,
  readObservationJsonlFiles,
  replaceObservationJsonlFile,
  serializeObservationJsonlLine,
} from "./observation-jsonl-files"

type FixtureEntry = {
  readonly value: string
}

function validateFixtureEntry(value: unknown): value is FixtureEntry {
  return typeof value === "object"
    && value !== null
    && "value" in value
    && typeof value.value === "string"
}

describe("observation JSONL files", () => {
  test("#given a temp root with permissive modes #when appending and replacing #then modes are 0700 and 0600", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "omo-jev-jsonl-modes-"))
    try {
      const path = join(rootDir, "wire-records.jsonl")
      chmodSync(rootDir, 0o777)
      ensureObservationJsonlDirectory(rootDir)
      const first = serializeObservationJsonlLine({ value: "first" }, validateFixtureEntry, 1024)
      const replacement = serializeObservationJsonlLine({ value: "replacement" }, validateFixtureEntry, 1024)
      expect(first).not.toBeNull()
      expect(replacement).not.toBeNull()
      if (first === null || replacement === null) return

      appendObservationJsonlLine(path, first)
      expect(observationJsonlFileSize(path)).toBe(Buffer.byteLength(first))
      replaceObservationJsonlFile(path, [replacement])

      expect(readFileSync(path, "utf8")).toBe(replacement)
      expect(statSync(rootDir).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("rejects a line above the byte cap without truncating it", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "omo-jev-jsonl-cap-"))
    try {
      const entry = { value: "계속" }
      const expectedLine = `${JSON.stringify(entry)}\n`
      const exactBytes = Buffer.byteLength(expectedLine)

      const exact = serializeObservationJsonlLine(entry, validateFixtureEntry, exactBytes)
      const oneByteOver = serializeObservationJsonlLine(entry, validateFixtureEntry, exactBytes - 1)

      expect(exact).toBe(expectedLine)
      expect(oneByteOver).toBeNull()
      expect(observationJsonlFileSize(join(rootDir, "missing.jsonl"))).toBe(0)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("#given malformed, invalid UTF-8, and empty lines #when iterated #then valid lines survive and bad lines are counted", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "omo-jev-jsonl-malformed-"))
    try {
      const path = join(rootDir, "wire-malformed.jsonl")
      writeFileSync(path, Buffer.concat([
        Buffer.from("\n"),
        Buffer.from([0xff, 0x0a]),
        Buffer.from(`${JSON.stringify({ value: "valid" })}\n`),
        Buffer.from('{"value":'),
      ]))

      const result = readObservationJsonlFile(path, validateFixtureEntry)

      expect(result.entries).toEqual([{ value: "valid" }])
      expect(result.malformedLines).toBe(2)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("#given mixed filename prefixes #when reading a wire corpus #then matching files are read in name order", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "omo-jev-jsonl-prefix-"))
    try {
      writeFileSync(join(rootDir, "wire-b.jsonl"), `${JSON.stringify({ value: "second" })}\n`)
      writeFileSync(join(rootDir, "other.jsonl"), `${JSON.stringify({ value: "ignored" })}\n`)
      writeFileSync(join(rootDir, "wire-a.jsonl"), `${JSON.stringify({ value: "first" })}\n`)

      const result = readObservationJsonlFiles(rootDir, "wire-", validateFixtureEntry)

      expect(result.entries).toEqual([{ value: "first" }, { value: "second" }])
      expect(result.malformedLines).toBe(0)
      expect(result.filesRead).toBe(2)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
