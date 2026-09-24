// allow: SIZE_OK - the sink acceptance matrix keeps persistence, accounting, and failure cases together.

import { describe, expect, test } from "bun:test"
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs"
import { homedir } from "os"
import { join } from "path"
import type {
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import {
  createIntentRoutingSink,
  readIntentRoutingSink,
} from "./intent-routing-sink"

const RECORDED_AT = "2026-09-24T12:00:00.000Z"
const NOW = () => new Date(RECORDED_AT)
const ZERO_COUNTERS: IntentRoutingCounters = {
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
const OBSERVATION: IntentRoutingObservationRecord = {
  kind: "observation",
  schemaVersion: 1,
  questionVersion: 1,
  recordedAt: RECORDED_AT,
  sessionID: "session-1",
  turnOrdinal: 1,
  dedupKey: "dedup-1",
  reuseKey: "reuse-1",
  predictionReused: false,
  promptHeadChars: "delegate the investigation",
  promptFullSha256: "a".repeat(64),
  promptChars: 26,
  truncatedInput: false,
  isContinuationCandidate: false,
  predictionStatus: "filled",
  notDispatchedReason: null,
  unavailableReason: null,
  resolvedModel: "jev-1.13.0",
  latencyMs: 42,
  answers: {
    intent: { choice: "implementation", confidence: 0.9, probabilities: { implementation: 0.9, research: 0.1 }, valid: true },
    category: { choice: "deep", confidence: 0.8, probabilities: { deep: 0.8, none: 0.2 }, valid: true },
    subagent: { choice: "none", confidence: 0.7, probabilities: { explore: 0.3, none: 0.7 }, valid: true },
    ambiguous: { noul: 0.1, valid: true },
  },
  invalidAnswerCount: 0,
  observed: [{
    tool: "task",
    category: "deep",
    subagentType: null,
    requestedSubagentType: null,
    taskId: null,
    normalizedCategory: "deep",
    normalizedSubagent: "none",
    routeClass: "category",
    callID: "call-1",
  }],
  observedAreAttempts: true,
  distinctCategoryCount: 1,
  distinctSubagentCount: 0,
  fanOutBucket: "one",
  correlationStatus: "reliable",
  sealedBy: "next_turn",
  counterEpoch: 0,
}

function testDirectory(name: string): string {
  return join(homedir(), ".omo", "jev-tests", name)
}

function identity(pid: number, suffix: string) {
  return { pid, processStartEpochNanos: 1_758_715_200_000_000_000n, randomSuffix: suffix }
}

function counterDelta(turnsSeen: number, monotonicSeq: number): IntentRoutingCounterDelta {
  return {
    kind: "counter_delta",
    schemaVersion: 1,
    recordedAt: RECORDED_AT,
    processId: "source-process",
    counterEpoch: 0,
    monotonicSeq,
    counters: { ...ZERO_COUNTERS, turnsSeen },
  }
}

describe("intent-routing JSONL sink", () => {
  test("#given an observation #when it is persisted and read #then its JSONL bytes round-trip unchanged", () => {
    const directory = testDirectory("observation")
    const sink = createIntentRoutingSink({ directory, identity: identity(101, "observation"), now: NOW })

    expect(sink.write(OBSERVATION)).toBe(true)
    sink.dispose()

    const firstLine = readFileSync(sink.filePath, "utf8").split("\n")[0]
    const result = readIntentRoutingSink({ directory })
    expect(`${firstLine}\n`).toBe(`${JSON.stringify(OBSERVATION)}\n`)
    expect(JSON.stringify(result.entries[0])).toBe(JSON.stringify(OBSERVATION))
  })

  test("#given cumulative counter deltas #when they are read #then the highest sequence wins instead of snapshots being summed", () => {
    const directory = testDirectory("counter")
    const sink = createIntentRoutingSink({ directory, identity: identity(102, "counter"), now: NOW })

    sink.write(counterDelta(4, 1))
    sink.write(counterDelta(7, 2))
    sink.dispose()

    const result = readIntentRoutingSink({ directory })
    const latest = result.latestCountersByProcess.get(sink.processId)
    expect(latest?.monotonicSeq).toBe(3)
    expect(latest?.counters.turnsSeen).toBe(7)
    expect(result.counters.turnsSeen).toBe(7)
  })

  test("#given no observations #when the sink is disposed #then a counter delta is still written", () => {
    const directory = testDirectory("dispose")
    const sink = createIntentRoutingSink({ directory, identity: identity(103, "dispose"), now: NOW })

    sink.dispose()

    const result = readIntentRoutingSink({ directory })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.kind).toBe("counter_delta")
  })

  test("#given a new sink #when its storage is inspected #then the directory is 0700 and file is 0600", () => {
    const directory = testDirectory("permissions")
    const sink = createIntentRoutingSink({ directory, identity: identity(104, "permissions"), now: NOW })

    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(sink.filePath).mode & 0o777).toBe(0o600)
    sink.dispose()
  })

  test("#given an entry beyond the line bound #when it is written #then it is rejected and counted without truncation", () => {
    const directory = testDirectory("oversized")
    const sink = createIntentRoutingSink({
      directory,
      identity: identity(105, "oversized"),
      now: NOW,
      maxLineBytes: 512,
      sizeCapBytes: 2048,
    })
    const oversized = { ...OBSERVATION, promptHeadChars: "x".repeat(2000) }

    expect(sink.write(oversized)).toBe(false)
    sink.dispose()

    const result = readIntentRoutingSink({ directory, maxLineBytes: 512 })
    expect(result.entries.every((entry) => entry.kind === "counter_delta")).toBe(true)
    expect(result.counters.malformedWriteRejections).toBe(1)
    expect(readFileSync(sink.filePath, "utf8")).not.toContain("x".repeat(2000))
  })

  test("#given a malformed trailing line #when the file is read #then valid entries remain and the malformed line is counted", () => {
    const directory = testDirectory("malformed")
    const sink = createIntentRoutingSink({ directory, identity: identity(106, "malformed"), now: NOW })
    sink.write(OBSERVATION)
    sink.dispose()
    appendFileSync(sink.filePath, '{"broken":')

    const result = readIntentRoutingSink({ directory })

    expect(result.entries).toHaveLength(2)
    expect(result.malformedLines).toBe(1)
  })

  test("#given two process identities #when both write #then distinct files are merged with counters resolved per process", () => {
    const directory = testDirectory("multi-process")
    const first = createIntentRoutingSink({ directory, identity: identity(201, "first"), now: NOW })
    const second = createIntentRoutingSink({ directory, identity: identity(202, "second"), now: NOW })
    first.write(counterDelta(3, 1))
    second.write(counterDelta(5, 1))
    first.dispose()
    second.dispose()

    const result = readIntentRoutingSink({ directory })

    expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2)
    expect(first.filePath).not.toBe(second.filePath)
    expect(result.latestCountersByProcess.size).toBe(2)
    expect(result.counters.turnsSeen).toBe(8)
  })

  test("#given a configured size cap #when it is crossed twice #then truncation advances epochs, resets corpus counters, and carries lifetime loss", () => {
    const directory = testDirectory("cap")
    const warnings: number[] = []
    const sink = createIntentRoutingSink({
      directory,
      identity: identity(301, "cap"),
      now: NOW,
      maxLineBytes: 2048,
      sizeCapBytes: 4096,
      onTruncate: (event) => { warnings.push(event.counterEpoch) },
    })
    let turnOrdinal = 1
    while (sink.counterEpoch < 1 && turnOrdinal < 50) {
      sink.write({ ...OBSERVATION, turnOrdinal })
      turnOrdinal += 1
    }
    const afterFirst = readIntentRoutingSink({ directory, maxLineBytes: 2048 })
    const firstLoss = afterFirst.recordsLostToCap
    while (sink.counterEpoch < 2 && turnOrdinal < 100) {
      sink.write({ ...OBSERVATION, turnOrdinal })
      turnOrdinal += 1
    }
    sink.dispose()

    const result = readIntentRoutingSink({ directory, maxLineBytes: 2048 })
    const latest = result.latestCountersByProcess.get(sink.processId)
    const retainedObservations = result.entries.filter((entry) => entry.kind === "observation")
    expect(latest?.counterEpoch).toBeGreaterThanOrEqual(2)
    expect(latest?.counters.recordsCreated).toBe(retainedObservations.length)
    expect(result.recordsLostToCap).toBeGreaterThan(firstLoss)
    expect(result.sinkTruncations).toBeGreaterThanOrEqual(2)
    expect(result.sinkTruncations).toBe(latest?.counterEpoch)
    expect(warnings).toHaveLength(result.sinkTruncations)
    expect(statSync(sink.filePath).size).toBeLessThanOrEqual(4096)
  })
})
