import type {
  IntentRoutingCounterDelta,
  IntentRoutingCounters,
  IntentRoutingEntry,
} from "@oh-my-opencode/jev-core"

export const INTENT_ROUTING_SINK_MAX_LINE_BYTES = 16 * 1024
export const INTENT_ROUTING_SINK_COUNTER_INTERVAL_MS = 30_000
export const INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES = 1724
export const INTENT_ROUTING_SINK_ASSUMED_TURNS_PER_DAY = 10_000
export const INTENT_ROUTING_SINK_RETENTION_DAYS = 4

const MEBIBYTE = 1024 * 1024
const BENCHMARK_WINDOW_BYTES = INTENT_ROUTING_SINK_BENCHMARK_OBSERVATION_BYTES *
  INTENT_ROUTING_SINK_ASSUMED_TURNS_PER_DAY * INTENT_ROUTING_SINK_RETENTION_DAYS

export const INTENT_ROUTING_SINK_SIZE_CAP_BYTES =
  Math.ceil(BENCHMARK_WINDOW_BYTES / MEBIBYTE) * MEBIBYTE

export const EMPTY_INTENT_ROUTING_COUNTERS: IntentRoutingCounters = {
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

export type IntentRoutingIntervalHandle = { readonly cancel: () => void }

export type IntentRoutingSinkOptions = {
  readonly homeDir?: string
  readonly processId?: string
  readonly now?: () => Date
  readonly maxLineBytes?: number
  readonly sizeCapBytes?: number
  readonly counterIntervalMs?: number
  readonly scheduleInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => IntentRoutingIntervalHandle
  readonly warn?: (message: string, data: Readonly<Record<string, unknown>>) => void
}

export type IntentRoutingSink = {
  readonly processId: string
  readonly filePath: string
  readonly append: (entry: IntentRoutingEntry) => boolean
  readonly updateCounters: (counters: IntentRoutingCounters) => void
  readonly flushCounters: () => void
  readonly getCounters: () => IntentRoutingCounters
  readonly getCounterEpoch: () => number
  readonly dispose: () => void
}

export type IntentRoutingSinkReadResult = {
  readonly entries: readonly IntentRoutingEntry[]
  readonly countersByProcess: ReadonlyMap<string, IntentRoutingCounterDelta>
  readonly malformedLines: number
  readonly files: readonly string[]
}

export class IntentRoutingSinkConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntentRoutingSinkConfigurationError"
  }
}
