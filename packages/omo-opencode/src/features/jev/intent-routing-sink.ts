import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "fs"
import { join } from "path"
import {
  validateIntentRoutingEntry,
  type IntentRoutingCounterDelta,
  type IntentRoutingEntry,
  type IntentRoutingObservationRecord,
} from "@oh-my-opencode/jev-core"
import {
  copyIntentRoutingCounters,
  createEmptyIntentRoutingCounters,
  mergeLatestSourceCounters,
  rebaseCorpusCounters,
} from "./intent-routing-sink-counters"
import { resolveIntentRoutingSinkOptions } from "./intent-routing-sink-config"
import type { IntentRoutingSinkOptions } from "./intent-routing-sink-config"

export {
  INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS,
  INTENT_ROUTING_SINK_SIZE_CAP_BYTES,
} from "./intent-routing-sink-config"
export type {
  IntentRoutingSinkIdentity,
  IntentRoutingSinkOptions,
  IntentRoutingSinkTruncation,
} from "./intent-routing-sink-config"

export {
  INTENT_ROUTING_SINK_MAX_LINE_BYTES,
  readIntentRoutingSink,
} from "./intent-routing-sink-reader"
export type {
  IntentRoutingSinkReadOptions,
  IntentRoutingSinkReadResult,
} from "./intent-routing-sink-reader"

export type IntentRoutingSink = Readonly<{
  processId: string
  filePath: string
  readonly counterEpoch: number
  write(entry: IntentRoutingEntry): boolean
  dispose(): void
}>

/**
 * Stores promptHeadChars verbatim in the user-scoped file. This sink performs no prompt scrubbing.
 */
export function createIntentRoutingSink(options: IntentRoutingSinkOptions = {}): IntentRoutingSink {
  const resolved = resolveIntentRoutingSinkOptions(options)
  const {
    directory,
    processId,
    now,
    maxLineBytes,
    sizeCapBytes,
    counterIntervalMs,
    onTruncate,
  } = resolved
  const utcDate = now().toISOString().slice(0, 10).replaceAll("-", "")
  const filePath = join(directory, `w1-${utcDate}-${processId}.jsonl`)
  const { schemaVersion } = resolved
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  writeFileSync(filePath, "", { encoding: "utf8", flag: "a", mode: 0o600 })
  chmodSync(filePath, 0o600)

  let counterEpoch = 0
  let monotonicSeq = 0
  let retainedObservations = 0
  let disposed = false
  let counters = createEmptyIntentRoutingCounters()
  const latestSourceCounters = createEmptyIntentRoutingCounters()
  let sourceBaseline = createEmptyIntentRoutingCounters()

  function encode(entry: IntentRoutingEntry): string | null {
    if (!validateIntentRoutingEntry(entry)) {
      counters.malformedWriteRejections += 1
      return null
    }
    const line = `${JSON.stringify(entry)}\n`
    if (Buffer.byteLength(line) > maxLineBytes) {
      counters.malformedWriteRejections += 1
      return null
    }
    return line
  }

  function buildCounterDelta(): IntentRoutingCounterDelta {
    monotonicSeq += 1
    return {
      kind: "counter_delta",
      schemaVersion,
      recordedAt: now().toISOString(),
      processId,
      counterEpoch,
      monotonicSeq,
      counters: copyIntentRoutingCounters(counters),
    }
  }

  function accountObservation(): void {
    retainedObservations += 1
    counters.recordsCreated = Math.max(
      counters.recordsCreated,
      retainedObservations + counters.recordsEvicted,
    )
  }

  function truncateAndWrite(trigger: IntentRoutingEntry): void {
    const recordsLostToCap = counters.recordsLostToCap + retainedObservations
    const sinkTruncations = counters.sinkTruncations + 1
    counterEpoch += 1
    retainedObservations = 0
    counters = createEmptyIntentRoutingCounters()
    counters.recordsLostToCap = recordsLostToCap
    counters.sinkTruncations = sinkTruncations
    sourceBaseline = copyIntentRoutingCounters(latestSourceCounters)
    const lines: string[] = []
    if (trigger.kind === "observation") {
      const observation = { ...trigger, counterEpoch }
      accountObservation()
      const observationLine = encode(observation)
      if (observationLine !== null) lines.push(observationLine)
    }
    const counterLine = encode(buildCounterDelta())
    if (counterLine !== null) lines.push(counterLine)
    writeFileSync(filePath, lines.join(""), { encoding: "utf8", mode: 0o600 })
    onTruncate({ filePath, counterEpoch, recordsLostToCap, sizeCapBytes })
  }

  function append(entry: IntentRoutingEntry, line: string): void {
    if (statSync(filePath).size + Buffer.byteLength(line) > sizeCapBytes) {
      truncateAndWrite(entry)
      return
    }
    appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 })
    if (entry.kind === "observation") accountObservation()
  }

  function emitCounterDelta(): void {
    const entry = buildCounterDelta()
    const line = encode(entry)
    if (line !== null) append(entry, line)
  }

  function write(entry: IntentRoutingEntry): boolean {
    if (disposed || !validateIntentRoutingEntry(entry)) {
      if (!disposed) counters.malformedWriteRejections += 1
      return false
    }
    const inputLine = `${JSON.stringify(entry)}\n`
    if (Buffer.byteLength(inputLine) > maxLineBytes) {
      counters.malformedWriteRejections += 1
      return false
    }
    switch (entry.kind) {
      case "observation": {
        const observation: IntentRoutingObservationRecord = { ...entry, counterEpoch }
        const line = encode(observation)
        if (line === null) return false
        append(observation, line)
        return true
      }
      case "counter_delta": {
        mergeLatestSourceCounters(latestSourceCounters, entry.counters)
        rebaseCorpusCounters(counters, latestSourceCounters, sourceBaseline, retainedObservations)
        emitCounterDelta()
        return true
      }
    }
  }

  const timer = setInterval(emitCounterDelta, counterIntervalMs)
  timer.unref()
  return {
    processId,
    filePath,
    get counterEpoch() { return counterEpoch },
    write,
    dispose() {
      if (disposed) return
      clearInterval(timer)
      emitCounterDelta()
      disposed = true
    },
  }
}
