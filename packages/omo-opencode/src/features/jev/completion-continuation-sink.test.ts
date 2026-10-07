/// <reference types="bun-types" />

import { describe, expect, jest, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { CompletionContinuationCounters } from "@oh-my-opencode/jev-core"
import { readCompletionContinuationSink } from "./completion-continuation-reader"
import {
  DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES,
  createCompletionContinuationSink,
  type CompletionContinuationSink,
  type CompletionContinuationSinkOptions,
} from "./completion-continuation-sink"
import {
  W2_FIXED_NOW,
  completionContinuationCounterDelta,
  completionContinuationCounters,
  completionContinuationObservation,
  completionContinuationProcessIdentity,
} from "./completion-continuation-sink.test-support"

function testRoot(): string {
  return mkdtempSync(join(tmpdir(), "omo-jev-w2-sink-test-"))
}

function sink(
  rootDir: string,
  pid: number,
  options: Omit<CompletionContinuationSinkOptions, "rootDir"> = {},
): CompletionContinuationSink {
  return createCompletionContinuationSink({
    rootDir,
    now: () => W2_FIXED_NOW,
    processIdentity: completionContinuationProcessIdentity(pid),
    counterFlushIntervalMs: 60_000,
    ...options,
  })
}

function removeTestRoot(rootDir: string, created?: CompletionContinuationSink): void {
  created?.dispose()
  rmSync(rootDir, { recursive: true, force: true })
}

describe("completion-continuation sink", () => {
  test("#given both entry kinds #when appended under an explicit root #then W2 bytes and modes are isolated", () => {
    const rootDir = testRoot()
    const unusedRoot = `${rootDir}-unused`
    const identity = completionContinuationProcessIdentity(801)
    const created = sink(rootDir, identity.pid)
    try {
      const observation = completionContinuationObservation()
      const counter = completionContinuationCounterDelta(identity, 4, completionContinuationCounters({ starts: 3 }))
      expect(created.append(observation)).toBe(true)
      expect(created.append(counter)).toBe(true)
      expect(created.path).toBe(join(rootDir, `w2-20260930-${created.processId}.jsonl`))
      expect(readFileSync(created.path, "utf8")).toBe(`${JSON.stringify(observation)}\n${JSON.stringify(counter)}\n`)
      expect(statSync(rootDir).mode & 0o777).toBe(0o700)
      expect(statSync(created.path).mode & 0o777).toBe(0o600)
      expect(existsSync(unusedRoot)).toBe(false)
    } finally { removeTestRoot(rootDir, created) }
  })

  test("counts a malformed trailing line and keeps valid W2 entries", () => {
    const rootDir = testRoot()
    const created = sink(rootDir, 802)
    try {
      const first = completionContinuationObservation({ sessionID: "ses_first" })
      const second = completionContinuationObservation({ sessionID: "ses_second", ordinal: 2 })
      expect(created.append(first)).toBe(true)
      expect(created.append(second)).toBe(true)
      appendFileSync(created.path, "{\"kind\":\"observation\"")
      const result = readCompletionContinuationSink(rootDir)
      expect(result.observations).toEqual([first, second])
      expect(result.malformedLines).toBe(1)
    } finally { removeTestRoot(rootDir, created) }
  })

  test("#given two concurrent writers #when entries interleave #then start-unique process files merge", () => {
    const rootDir = testRoot()
    const first = sink(rootDir, 803)
    const second = sink(rootDir, 804)
    try {
      expect(first.append(completionContinuationObservation({ sessionID: "ses_first" }))).toBe(true)
      expect(second.append(completionContinuationObservation({ sessionID: "ses_second" }))).toBe(true)
      first.dispose()
      second.dispose()
      const result = readCompletionContinuationSink(rootDir)
      expect(first.path).not.toBe(second.path)
      expect(result.filesRead).toBe(2)
      expect([...result.latestCountersByProcess.keys()].sort()).toEqual([first.processId, second.processId].sort())
    } finally {
      first.dispose()
      second.dispose()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("#given a size cap #when atomic truncate starts a new epoch #then stale counters are not resurrected", () => {
    const rootDir = testRoot()
    const identity = completionContinuationProcessIdentity(805)
    let source: CompletionContinuationCounters = completionContinuationCounters({ starts: 1 })
    const largeDigest = `sha256:${"x".repeat(2048)}`
    const first = completionContinuationObservation({ sessionID: "ses_old", inputDigests: {
      todoStatus: largeDigest, transcript: null, diff: null, boulder: null,
    } })
    const retained = completionContinuationObservation({ sessionID: "ses_retained", ordinal: 2, inputDigests: {
      todoStatus: largeDigest, transcript: null, diff: null, boulder: null,
    } })
    const epochCounter = completionContinuationCounterDelta(identity, 1, completionContinuationCounters({
      starts: 1, recordsLostToCap: 1, sinkTruncations: 1,
    }), 1)
    const cap = Buffer.byteLength(`${JSON.stringify(retained)}\n${JSON.stringify(epochCounter)}\n`) + 8
    const created = sink(rootDir, identity.pid, { sizeCapBytes: cap, getCounters: () => source })
    try {
      expect(created.append(first)).toBe(true)
      source = completionContinuationCounters({ starts: 2 })
      expect(created.append(retained)).toBe(true)
      appendFileSync(created.path, `${JSON.stringify(completionContinuationCounterDelta(
        identity, 999, completionContinuationCounters({ starts: 999 }), 0,
      ))}\n`)
      const result = readCompletionContinuationSink(rootDir)
      const latest = result.latestCountersByProcess.get(created.processId)
      expect(result.observations.map((entry) => entry.sessionID)).toEqual(["ses_retained"])
      expect(latest?.counterEpoch).toBe(1)
      expect(latest?.counters.starts).toBe(1)
      expect(latest?.counters.recordsLostToCap).toBe(1)
    } finally { removeTestRoot(rootDir, created) }
  })

  test("#given a valid entry above 64 KiB #when appended #then the write is rejected and counted", () => {
    const rootDir = testRoot()
    const created = sink(rootDir, 806)
    try {
      const oversized = completionContinuationObservation({ sessionID: "x".repeat(DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES) })
      expect(created.append(oversized)).toBe(false)
      created.dispose()
      const latest = readCompletionContinuationSink(rootDir).latestCountersByProcess.get(created.processId)
      expect(latest?.counters.malformedWriteRejections).toBe(1)
    } finally { removeTestRoot(rootDir, created) }
  })

  test("#given the periodic counter timer #when time advances #then it flushes and remains unrefed", () => {
    jest.useFakeTimers()
    const rootDir = testRoot()
    const created = sink(rootDir, 807, { counterFlushIntervalMs: 50 })
    try {
      expect(created.counterIntervalHasRef()).toBe(false)
      jest.advanceTimersByTime(50)
      const latest = readCompletionContinuationSink(rootDir).latestCountersByProcess.get(created.processId)
      expect(latest?.monotonicSeq).toBe(1)
    } finally {
      removeTestRoot(rootDir, created)
      jest.useRealTimers()
    }
  })

  test("#given dispose reenters during a pending flush #when repeated #then one counter is written without loss", () => {
    const rootDir = testRoot()
    let created: CompletionContinuationSink | undefined
    const current = completionContinuationCounters({ starts: 7 })
    created = sink(rootDir, 808, { getCounters: () => {
      created?.dispose()
      return current
    } })
    try {
      expect(() => created?.dispose()).not.toThrow()
      expect(() => created?.dispose()).not.toThrow()
      const result = readCompletionContinuationSink(rootDir)
      expect(result.entries.filter((entry) => entry.kind === "counter_delta")).toHaveLength(1)
      expect(result.latestCountersByProcess.get(created.processId)?.counters.starts).toBe(7)
    } finally { removeTestRoot(rootDir, created) }
  })

  test.each([
    ["an empty line", "\n", 0],
    ["a truncated JSON tail", "{\"kind\":\n", 1],
    ["a valid JSON line over 64 KiB", `${JSON.stringify(completionContinuationObservation({
      sessionID: "y".repeat(DEFAULT_COMPLETION_CONTINUATION_MAX_LINE_BYTES),
    }))}\n`, 1],
    ["a valid JSON line failing closed-key validation", `${JSON.stringify({
      ...completionContinuationObservation(), extra: true,
    })}\n`, 1],
    ["a counter carrying observation-only keys", `${JSON.stringify({
      ...completionContinuationCounterDelta(
        completionContinuationProcessIdentity(809),
        3,
        completionContinuationCounters(),
      ),
      outcomeFacts: completionContinuationObservation().outcomeFacts,
    })}\n`, 1],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a]), 1],
  ])("#given %s #when read #then the malformed observable is isolated", (_name, payload, malformedLines) => {
    const rootDir = testRoot()
    const created = sink(rootDir, 809)
    try {
      const valid = completionContinuationObservation()
      expect(created.append(valid)).toBe(true)
      created.dispose()
      appendFileSync(created.path, payload)
      const result = readCompletionContinuationSink(rootDir)
      expect(result.observations).toEqual([valid])
      expect(result.malformedLines).toBe(malformedLines)
    } finally { removeTestRoot(rootDir, created) }
  })
})
