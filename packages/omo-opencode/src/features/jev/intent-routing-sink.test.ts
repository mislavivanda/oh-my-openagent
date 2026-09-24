import { afterEach, describe, expect, jest, test } from "bun:test"
import { appendFileSync, readFileSync, rmSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { IntentRoutingCounters } from "@oh-my-opencode/jev-core"
import { readIntentRoutingSink } from "./intent-routing-reader"
import { createIntentRoutingSink, type IntentRoutingSink } from "./intent-routing-sink"
import {
  FIXED_NOW,
  counterDelta,
  counters,
  observation,
  processId,
  processIdentity,
} from "./intent-routing-sink.test-support"

const rootDir = join(homedir(), ".omo", "jev")
const openSinks: IntentRoutingSink[] = []

function sink(pid: number, options: Parameters<typeof createIntentRoutingSink>[0] = {}): IntentRoutingSink {
  const created = createIntentRoutingSink({
    rootDir,
    now: () => FIXED_NOW,
    processIdentity: processIdentity(pid),
    counterFlushIntervalMs: 60_000,
    ...options,
  })
  openSinks.push(created)
  return created
}

afterEach(() => {
  for (const created of openSinks.splice(0)) created.dispose()
  rmSync(rootDir, { recursive: true, force: true })
  jest.useRealTimers()
})

describe("intent-routing sink", () => {
  test("#given an observation #when appended #then its JSON bytes and restrictive modes round-trip", () => {
    const created = sink(101)
    const entry = observation()

    expect(created.append(entry)).toBe(true)

    expect(readFileSync(created.path, "utf8")).toBe(`${JSON.stringify(entry)}\n`)
    expect(statSync(rootDir).mode & 0o777).toBe(0o700)
    expect(statSync(created.path).mode & 0o777).toBe(0o600)
  })

  test("#given cumulative counter entries #when read #then the highest sequence wins without summing", () => {
    const identity = processIdentity(102)
    const created = sink(identity.pid)
    const first = counterDelta(identity, 1, counters({ recordsCreated: 3 }))
    const latest = counterDelta(identity, 2, counters({ recordsCreated: 5 }))

    expect(created.append(first)).toBe(true)
    expect(created.append(latest)).toBe(true)
    const result = readIntentRoutingSink(rootDir)

    expect(result.entries).toEqual([first, latest])
    expect(result.latestCountersByProcess.get(processId(identity))).toEqual(latest)
    expect(result.latestCountersByProcess.get(processId(identity))?.counters.recordsCreated).toBe(5)
  })

  test("#given no observations #when disposed #then one cumulative counter entry is persisted", () => {
    const identity = processIdentity(103)
    const created = sink(identity.pid)

    created.dispose()
    const result = readIntentRoutingSink(rootDir)

    expect(result.observations).toHaveLength(0)
    expect(result.latestCountersByProcess.get(processId(identity))?.monotonicSeq).toBe(1)
  })

  test("#given the bounded flush interval #when it elapses #then cumulative counters are persisted", () => {
    jest.useFakeTimers()
    const identity = processIdentity(109)
    sink(identity.pid, { counterFlushIntervalMs: 50 })

    jest.advanceTimersByTime(50)
    const result = readIntentRoutingSink(rootDir)

    expect(result.latestCountersByProcess.get(processId(identity))?.monotonicSeq).toBe(1)
  })

  test("#given a valid entry above the line bound #when appended #then it is rejected and counted", () => {
    const identity = processIdentity(104)
    const baseBytes = Buffer.byteLength(`${JSON.stringify(observation())}\n`)
    const created = sink(identity.pid, { maxLineBytes: baseBytes + 1 })
    const oversized = observation({ promptHeadChars: "x".repeat(baseBytes) })

    expect(created.append(oversized)).toBe(false)
    created.dispose()
    const result = readIntentRoutingSink(rootDir)

    expect(result.observations).toHaveLength(0)
    expect(result.latestCountersByProcess.get(processId(identity))?.counters.malformedWriteRejections).toBe(1)
  })

  test("#given a malformed trailing line #when read #then valid records survive and the line is counted", () => {
    const created = sink(105)
    const entry = observation()
    expect(created.append(entry)).toBe(true)
    appendFileSync(created.path, "{\"broken\":")

    const result = readIntentRoutingSink(rootDir)

    expect(result.observations).toEqual([entry])
    expect(result.malformedLines).toBe(1)
  })

  test("#given two process identities #when both dispose #then distinct files merge by process", () => {
    const firstIdentity = processIdentity(106)
    const secondIdentity = processIdentity(107)
    const first = sink(firstIdentity.pid)
    const second = sink(secondIdentity.pid)

    first.dispose()
    second.dispose()
    const result = readIntentRoutingSink(rootDir)

    expect(first.path).not.toBe(second.path)
    expect(result.filesRead).toBe(2)
    expect([...result.latestCountersByProcess.keys()].sort()).toEqual([
      processId(firstIdentity),
      processId(secondIdentity),
    ])
  })

  test("#given repeated cap truncations #when epochs advance #then corpus counters reset and lifetime loss carries", () => {
    let source: IntentRoutingCounters = counters({ turnsSeen: 1, recordsCreated: 1 })
    const warnings: string[] = []
    const lineBytes = Buffer.byteLength(`${JSON.stringify(observation())}\n`)
    const created = sink(108, {
      sizeCapBytes: lineBytes + 512,
      getCounters: () => source,
      onWarning: (message) => warnings.push(message),
    })
    expect(created.append(observation({ sessionID: "first" }))).toBe(true)

    source = counters({ turnsSeen: 2, recordsCreated: 2 })
    expect(created.append(observation({ sessionID: "second" }))).toBe(true)
    source = counters({ turnsSeen: 3, recordsCreated: 3 })
    expect(created.append(observation({ sessionID: "third" }))).toBe(true)
    const result = readIntentRoutingSink(rootDir)
    const latest = result.latestCountersByProcess.get(created.processId)

    expect(result.observations.map((entry) => entry.sessionID)).toEqual(["third"])
    expect(latest?.counterEpoch).toBe(2)
    expect(latest?.counters.recordsCreated).toBe(1)
    expect(latest?.counters.recordsEvicted).toBe(0)
    expect(latest?.counters.recordsLostToCap).toBe(2)
    expect(latest?.counters.sinkTruncations).toBe(2)
    expect(warnings).toHaveLength(2)
  })
})
