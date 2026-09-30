import {
  validateCompletionContinuationEntry,
  type CompletionContinuationDecisionResult,
  type CompletionContinuationEntry,
  type CompletionContinuationHeuristicFacts,
  type DecisionBackend,
  type DecisionOutcome,
  type DecisionRequest,
  type Questions,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema, type JevConfig } from "../../config/schema/jev"
import type {
  CompletionContinuationBoulderSnapshot,
  ScheduleCompletionContinuationBoulderSnapshotInput,
} from "./completion-continuation-boulder-snapshot"
import type {
  JevCompletionContinuationClock,
  JevCompletionContinuationSink,
} from "./completion-continuation"

export const HEURISTIC_FACTS: CompletionContinuationHeuristicFacts = {
  gauntletOutcome: "continuation_scheduled",
  todoComplete: false,
  promiseComplete: false,
  todoProgress: false,
  stagnationStop: false,
}

export const FILLED_RESULT: CompletionContinuationDecisionResult = {
  predictionStatus: "filled",
  unavailableReason: null,
  resolvedModel: "jev-test-v1",
  latencyMs: 4,
  probabilities: { actuallyComplete: 0.1, progressing: 0.9, stuck: 0.2 },
  thresholdLabels: {
    actuallyComplete: "would_false",
    progressing: "would_true",
    stuck: "would_false",
  },
  invalidAnswerCount: 0,
  threshold: 0.8,
  questionVersion: 1,
}

export function enabledConfig(
  backend: "mock" | "real" | "llm-adapter" = "mock",
  maxInflight = 8,
): JevConfig {
  return JevConfigSchema.parse({
    enabled: true,
    backend,
    model: "jev-test",
    wires: { completion_continuation: { enabled: true, max_inflight: maxInflight } },
  })
}

export function completedTodo(content = "original todo") {
  return [{ id: "todo-1", status: "completed", content }] as const
}

export function incompleteTodo(content = "original todo") {
  return [{ id: "todo-1", status: "in_progress", content }] as const
}

export function transcript(content = "original transcript") {
  return [{ role: "assistant", content, synthetic: false }]
}

export const BOULDER_UNAVAILABLE: CompletionContinuationBoulderSnapshot = {
  input: null,
  availability: { status: "unavailable", reason: "boulder_not_found" },
  capturedAt: 10,
  digest: null,
  titleTruncated: false,
}

export class ManualBoulderScheduler {
  readonly pending: {
    readonly input: ScheduleCompletionContinuationBoulderSnapshotInput
    active: boolean
  }[] = []

  readonly schedule = (input: ScheduleCompletionContinuationBoulderSnapshotInput) => {
    const task = { input, active: true }
    this.pending.push(task)
    return { cancel: () => { task.active = false } }
  }

  runAll(snapshot = BOULDER_UNAVAILABLE): void {
    for (const task of this.pending.splice(0)) {
      if (task.active) task.input.onSnapshot(snapshot)
    }
  }

  get activeCount(): number {
    return this.pending.filter((task) => task.active).length
  }
}

type ManualTimer = {
  readonly delayMs: number
  readonly callback: () => void
  active: boolean
  unrefed: boolean
}

export class ManualClock implements JevCompletionContinuationClock {
  private current = 0
  readonly timers: ManualTimer[] = []

  now = (): number => this.current

  schedule = (delayMs: number, callback: () => void) => {
    const timer: ManualTimer = { delayMs, callback, active: true, unrefed: false }
    this.timers.push(timer)
    return {
      cancel: () => { timer.active = false },
      unref: () => { timer.unrefed = true },
    }
  }

  fire(delayMs: number): void {
    this.current += delayMs
    for (const timer of this.timers) {
      if (!timer.active || timer.delayMs !== delayMs) continue
      timer.active = false
      timer.callback()
    }
  }
}

export class MemorySink implements JevCompletionContinuationSink {
  readonly entries: CompletionContinuationEntry[] = []
  flushes = 0
  disposals = 0
  throwOnAppend = false

  append = (entry: unknown): boolean => {
    if (this.throwOnAppend) throw new TypeError("sink write failed")
    if (!validateCompletionContinuationEntry(entry)) return false
    this.entries.push(entry)
    return true
  }

  flushCounters = (): void => { this.flushes += 1 }
  dispose = (): void => { this.disposals += 1 }
}

export function rawAnswerBackend(
  onRequest?: (request: DecisionRequest<Questions>) => void,
): DecisionBackend {
  return {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      onRequest?.(request)
      return JSON.parse(JSON.stringify({
        status: "decided",
        answers: {
          actually_complete: { type: "noul", noul: 0.1 },
          progressing: { type: "noul", noul: 0.9 },
          stuck: { type: "noul", noul: 0.2 },
        },
        model: "jev-test-v1",
        usage: { input_tokens: 3, output_tokens: 3 },
        latencyMs: 4,
      }))
    },
  }
}

export async function drainAsync(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

export function observationEntries(sink: MemorySink) {
  return sink.entries.filter((entry) => entry.kind === "observation")
}
