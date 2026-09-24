// allow: SIZE_OK - Permission, lazy-root, call-time HOME, truncation, epoch, and malformed-tail cases share one temp-home filesystem fixture and assert one JSONL contract.

import { afterEach, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
  INTENT_ROUTING_SCHEMA_VERSION,
  type IntentRoutingCounterDelta,
  type IntentRoutingCounters,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"

import {
  INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES,
  INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS,
  createIntentRoutingProcessId,
  createIntentRoutingSink,
  readIntentRoutingSink,
  type IntentRoutingIntervalHandle,
  type IntentRoutingSinkOptions,
} from "./intent-routing-sink"

const FIXED_DATE = new Date("2026-09-24T12:00:00.000Z")
const PROCESS_ID = "4100-1790251200000000000-abcdef123456"
const roots: string[] = []

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

function testHome(): string {
  const parent = process.env.HOME ?? "/tmp"
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "jev-intent-routing-sink-"))
  roots.push(root)
  return root
}

function counters(overrides: Partial<IntentRoutingCounters> = {}): IntentRoutingCounters {
  return { ...ZERO_COUNTERS, ...overrides }
}

export function fullyPopulatedObservation(
  overrides: Partial<IntentRoutingObservationRecord> = {},
): IntentRoutingObservationRecord {
  const promptHeadChars = "Implement a fully typed routing sink with secure JSONL persistence. ".padEnd(200, "x")
  return {
    kind: "observation",
    schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
    questionVersion: 1,
    recordedAt: FIXED_DATE.toISOString(),
    sessionID: "session-main",
    turnOrdinal: 1,
    dedupKey: "dedup-key-1",
    reuseKey: "reuse-key-1",
    predictionReused: false,
    promptHeadChars,
    promptFullSha256: "a".repeat(64),
    promptChars: 243,
    truncatedInput: true,
    isContinuationCandidate: false,
    predictionStatus: "filled",
    notDispatchedReason: null,
    unavailableReason: null,
    resolvedModel: "jev-2026-09-24",
    latencyMs: 147,
    answers: {
      intent: {
        choice: "implementation",
        confidence: 0.9,
        probabilities: { implementation: 0.9, research: 0.1 },
        valid: true,
      },
      category: {
        choice: "deep",
        confidence: 0.8,
        probabilities: { deep: 0.8, none: 0.2 },
        valid: true,
      },
      subagent: {
        choice: "none",
        confidence: 0.95,
        probabilities: { none: 0.95, explore: 0.05 },
        valid: true,
      },
      ambiguous: { noul: 0.1, valid: true },
    },
    invalidAnswerCount: 0,
    observed: [
      {
        tool: "task",
        category: "deep",
        subagentType: null,
        requestedSubagentType: null,
        taskId: null,
        normalizedCategory: "deep",
        normalizedSubagent: "none",
        routeClass: "category",
        callID: "call-1",
      },
      {
        tool: "call_omo_agent",
        category: null,
        subagentType: "explore",
        requestedSubagentType: "explore",
        taskId: null,
        normalizedCategory: "none",
        normalizedSubagent: "explore",
        routeClass: "subagent",
        callID: "call-2",
      },
    ],
    observedAreAttempts: true,
    distinctCategoryCount: 1,
    distinctSubagentCount: 1,
    fanOutBucket: "many",
    correlationStatus: "reliable",
    sealedBy: "session_idle",
    counterEpoch: 0,
    ...overrides,
  }
}

function counterDelta(
  monotonicSeq: number,
  snapshot: IntentRoutingCounters,
  overrides: Partial<IntentRoutingCounterDelta> = {},
): IntentRoutingCounterDelta {
  return {
    kind: "counter_delta",
    schemaVersion: INTENT_ROUTING_SCHEMA_VERSION,
    recordedAt: FIXED_DATE.toISOString(),
    processId: PROCESS_ID,
    counterEpoch: 0,
    monotonicSeq,
    counters: snapshot,
    ...overrides,
  }
}

const noInterval = (): IntentRoutingIntervalHandle => ({ cancel: () => undefined })

function createTestSink(
  homeDir: string,
  options: Omit<IntentRoutingSinkOptions, "homeDir" | "processId" | "now"> = {},
) {
  return createIntentRoutingSink({
    homeDir,
    processId: PROCESS_ID,
    now: () => FIXED_DATE,
    scheduleInterval: noInterval,
    ...options,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("intent-routing JSONL sink", () => {
  test("#given an unused sink #when disposed #then it leaves no output directory", () => {
    const homeDir = testHome()
    const rootDir = join(homeDir, ".omo", "jev")
    const sink = createTestSink(homeDir)

    sink.dispose()

    expect(existsSync(rootDir)).toBe(false)
  })

  test("#given HOME changes after module load #when the sink writes #then only the call-time home receives output", () => {
    const originalHome = process.env.HOME
    const realHome = homedir()
    const sandboxHome = testHome()
    const rootDir = join(sandboxHome, ".omo", "jev")
    const expectedFile = join(rootDir, `w1-20260924-${PROCESS_ID}.jsonl`)
    const realHomeFile = join(realHome, ".omo", "jev", `w1-20260924-${PROCESS_ID}.jsonl`)
    process.env.HOME = sandboxHome

    try {
      const sink = createIntentRoutingSink({
        processId: PROCESS_ID,
        now: () => FIXED_DATE,
        scheduleInterval: noInterval,
      })
      expect(sink.filePath).toBe(expectedFile)

      expect(sink.append(fullyPopulatedObservation())).toBe(true)
      sink.dispose()

      expect(existsSync(expectedFile)).toBe(true)
      expect(existsSync(realHomeFile)).toBe(false)
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  test("#given an observation #when appended and read #then it round-trips byte-identically", () => {
    const sink = createTestSink(testHome())
    const entry = fullyPopulatedObservation()
    expect(Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8")).toBe(
      INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES,
    )

    expect(sink.append(entry)).toBe(true)

    const raw = existsSync(sink.filePath) ? readFileSync(sink.filePath, "utf8") : ""
    expect(raw).toBe(`${JSON.stringify(entry)}\n`)
    expect(readIntentRoutingSink(dirname(sink.filePath)).entries).toEqual([entry])
    sink.dispose()
  })

  test("#given counter snapshots #when read #then the highest sequence replaces rather than sums", () => {
    const sink = createTestSink(testHome())
    const first = counterDelta(1, counters({ turnsSeen: 5 }))
    const second = counterDelta(2, counters({ turnsSeen: 8 }))

    expect(sink.append(first)).toBe(true)
    expect(sink.append(second)).toBe(true)

    const result = readIntentRoutingSink(dirname(sink.filePath))
    expect(result.entries).toEqual([first, second])
    expect(result.countersByProcess.get(PROCESS_ID)?.counters.turnsSeen).toBe(8)
    expect(result.countersByProcess.get(PROCESS_ID)?.counters.turnsSeen).not.toBe(13)
    sink.dispose()
  })

  test("#given no observations #when disposed #then a cumulative counter entry is emitted", () => {
    const sink = createTestSink(testHome())
    sink.updateCounters(counters({ turnsSeen: 3, recordsCreated: 2 }))

    sink.dispose()

    const result = readIntentRoutingSink(dirname(sink.filePath))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      kind: "counter_delta",
      processId: PROCESS_ID,
      monotonicSeq: 1,
      counters: { turnsSeen: 3, recordsCreated: 2 },
    })
  })

  test("#given a scheduled interval #when it fires #then counters flush at the bounded interval", () => {
    let scheduled: (() => void) | undefined
    let scheduledMs = 0
    const sink = createTestSink(testHome(), {
      scheduleInterval: (callback, intervalMs) => {
        scheduled = callback
        scheduledMs = intervalMs
        return { cancel: () => undefined }
      },
    })
    sink.updateCounters(counters({ turnsSeen: 4 }))

    scheduled?.()

    expect(scheduledMs).toBe(INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS)
    expect(readIntentRoutingSink(dirname(sink.filePath)).countersByProcess.get(PROCESS_ID)?.counters.turnsSeen).toBe(4)
    sink.dispose()
  })

  test("#given a fresh sink #when it writes #then directory and file permissions are restrictive", () => {
    const sink = createTestSink(testHome())
    sink.append(fullyPopulatedObservation())

    expect(existsSync(sink.filePath)).toBe(true)
    if (!existsSync(sink.filePath)) return
    expect(statSync(dirname(sink.filePath)).mode & 0o777).toBe(0o700)
    expect(statSync(sink.filePath).mode & 0o777).toBe(0o600)
    sink.dispose()
  })

  test("#given an entry above max line size #when appended #then it is rejected and counted without truncation", () => {
    const sink = createTestSink(testHome(), { maxLineBytes: 1024 })

    expect(sink.append(fullyPopulatedObservation())).toBe(false)
    sink.dispose()

    const result = readIntentRoutingSink(dirname(sink.filePath))
    expect(result.entries.filter((entry) => entry.kind === "observation")).toEqual([])
    expect(result.countersByProcess.get(PROCESS_ID)?.counters.malformedWriteRejections).toBe(1)
  })

  test("#given a malformed trailing line #when read #then valid rows survive and malformedLines increments", () => {
    const sink = createTestSink(testHome())
    const entry = fullyPopulatedObservation()
    sink.append(entry)
    expect(existsSync(sink.filePath)).toBe(true)
    if (!existsSync(sink.filePath)) return
    appendFileSync(sink.filePath, '{"broken":\n')

    const result = readIntentRoutingSink(dirname(sink.filePath))

    expect(result.entries).toEqual([entry])
    expect(result.malformedLines).toBe(1)
    sink.dispose()
  })

  test("#given two simulated process writers #when read #then files stay distinct and counters resolve per process", () => {
    const homeDir = testHome()
    const firstId = createIntentRoutingProcessId({
      pid: 4101,
      processStartEpochNanos: "1790251200000000000",
      randomSuffix: "aaaaaaaaaaaa",
    })
    const secondId = createIntentRoutingProcessId({
      pid: 4102,
      processStartEpochNanos: "1790251200000000001",
      randomSuffix: "bbbbbbbbbbbb",
    })
    const first = createIntentRoutingSink({ homeDir, processId: firstId, now: () => FIXED_DATE, scheduleInterval: noInterval })
    const second = createIntentRoutingSink({ homeDir, processId: secondId, now: () => FIXED_DATE, scheduleInterval: noInterval })
    first.updateCounters(counters({ turnsSeen: 2 }))
    second.updateCounters(counters({ turnsSeen: 7 }))
    first.dispose()
    second.dispose()

    const result = readIntentRoutingSink(dirname(first.filePath))

    expect(result.files.map((file) => basename(file)).sort()).toEqual([
      `w1-20260924-${firstId}.jsonl`,
      `w1-20260924-${secondId}.jsonl`,
    ])
    expect(result.countersByProcess.get(firstId)?.counters.turnsSeen).toBe(2)
    expect(result.countersByProcess.get(secondId)?.counters.turnsSeen).toBe(7)
  })

  test("#given a configured size cap #when writes reach it #then the file truncates once and warns", () => {
    const warnings: Array<Readonly<Record<string, unknown>>> = []
    const sink = createTestSink(testHome(), {
      maxLineBytes: 4096,
      sizeCapBytes: 20 * 1024,
      warn: (_message, data) => warnings.push(data),
    })

    let ordinal = 1
    while (sink.getCounterEpoch() === 0 && ordinal <= 20) {
      sink.updateCounters(counters({ turnsSeen: ordinal, recordsCreated: ordinal }))
      sink.append(fullyPopulatedObservation({ turnOrdinal: ordinal, dedupKey: `dedup-${ordinal}` }))
      sink.flushCounters()
      ordinal += 1
    }

    expect(sink.getCounterEpoch()).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(existsSync(sink.filePath)).toBe(true)
    if (!existsSync(sink.filePath)) return
    expect(statSync(sink.filePath).size).toBeLessThanOrEqual(20 * 1024)
    sink.dispose()
  })

  test("#given pre-truncation counters #when a new epoch is written #then it supersedes rather than adds", () => {
    const sink = createTestSink(testHome(), {
      maxLineBytes: 4096,
      sizeCapBytes: 20 * 1024,
      warn: () => undefined,
    })
    let ordinal = 1
    while (sink.getCounterEpoch() === 0 && ordinal <= 20) {
      sink.updateCounters(counters({ turnsSeen: ordinal, recordsCreated: ordinal }))
      sink.append(fullyPopulatedObservation({ turnOrdinal: ordinal, dedupKey: `dedup-${ordinal}` }))
      sink.flushCounters()
      ordinal += 1
    }
    const lostAfterFirstTruncation = sink.getCounters().recordsLostToCap
    while (sink.getCounterEpoch() === 1 && ordinal <= 40) {
      sink.updateCounters(counters({ turnsSeen: ordinal, recordsCreated: ordinal }))
      sink.append(fullyPopulatedObservation({ turnOrdinal: ordinal, dedupKey: `dedup-${ordinal}` }))
      sink.flushCounters()
      ordinal += 1
    }
    sink.dispose()

    const result = readIntentRoutingSink(dirname(sink.filePath))
    const resolved = result.countersByProcess.get(PROCESS_ID)
    const retained = result.entries.filter(
      (entry) => entry.kind === "observation" && entry.counterEpoch === resolved?.counterEpoch,
    ).length

    expect(resolved?.counterEpoch).toBe(2)
    expect(resolved?.counters.sinkTruncations).toBe(2)
    expect(resolved?.counters.recordsLostToCap).toBeGreaterThan(lostAfterFirstTruncation)
    expect(resolved?.counters.recordsCreated).toBe(retained)
  })
})
