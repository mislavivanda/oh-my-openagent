import { homedir } from "node:os"
import { join } from "node:path"
import {
  decideCompletionContinuation,
  selectDecisionBackend,
  type CompletionContinuationCounters,
  type CompletionContinuationDecisionArgs,
  type CompletionContinuationDecisionResult,
  type CompletionContinuationHeuristicFacts,
  type DecisionBackend,
  type DecisionBackendDeps,
} from "@oh-my-opencode/jev-core"
import type { JevCompletionContinuationWireConfig, JevConfig } from "../../config/schema/jev"
import { log } from "../../shared"
import {
  scheduleCompletionContinuationBoulderSnapshot,
  type ScheduleCompletionContinuationBoulderSnapshotInput,
} from "./completion-continuation-boulder-snapshot"
import { createCompletionContinuationDiffCache, type CompletionContinuationDiffCache, type CompletionContinuationObservedEvent } from "./completion-continuation-diff-cache"
import { createCompletionContinuationDispatchController } from "./completion-continuation-dispatch"
import type { CompletionContinuationTodoSource, CompletionContinuationTranscriptSource } from "./completion-continuation-input"
import { createCompletionContinuationOutcomeStore } from "./completion-continuation-outcome-store"
import type { CompletionContinuationOutcomeClock, CompletionContinuationOutcomeStore } from "./completion-continuation-outcome-types"
import { createCompletionContinuationSink } from "./completion-continuation-sink"
import { emptyCompletionContinuationCounters } from "./completion-continuation-sink-counters"

export type JevCompletionContinuationClock = CompletionContinuationOutcomeClock
export type JevCompletionContinuationDispatcher = (
  args: CompletionContinuationDecisionArgs,
) => Promise<CompletionContinuationDecisionResult>
export type JevCompletionContinuationScheduler = (
  input: ScheduleCompletionContinuationBoulderSnapshotInput,
) => { cancel(): void }
export type JevCompletionContinuationSink = {
  append(entry: unknown): boolean
  flushCounters(): void
  dispose(): void
}
export type JevCompletionContinuationBeginInput = {
  readonly sessionID: string
  readonly directory: string
  readonly todos: readonly CompletionContinuationTodoSource[]
  readonly transcript: readonly CompletionContinuationTranscriptSource[]
  readonly isContinuationCandidate: boolean
}
export type JevCompletionContinuationInspection = {
  readonly inFlight: number
  readonly dispatchesDropped: number
  readonly pendingDecisions: number
  readonly diffSessions: number
}
export type JevCompletionContinuation = {
  readonly enabled: boolean
  observeEvent(event: CompletionContinuationObservedEvent): void
  beginIdle(input: JevCompletionContinuationBeginInput): boolean
  finishHeuristic(sessionID: string, facts: CompletionContinuationHeuristicFacts): boolean
  markContinuationActivity(sessionID: string, successful: boolean): boolean
  humanIntervention(sessionID: string): number
  deleteSession(sessionID: string): void
  getCounters(): CompletionContinuationCounters
  inspect(): JevCompletionContinuationInspection
  dispose(): Promise<void>
}
export type CreateJevCompletionContinuationOptions = {
  readonly jevConfig: JevConfig | undefined
  readonly env?: { readonly TYPESAFE_API_KEY?: string; readonly OMO_JEV_BASE_URL?: string | undefined }
  readonly backend?: DecisionBackend
  readonly dispatcher?: JevCompletionContinuationDispatcher
  readonly sink?: JevCompletionContinuationSink
  readonly clock?: JevCompletionContinuationClock
  readonly scheduler?: JevCompletionContinuationScheduler
  readonly logger?: (message: string, data?: unknown) => void
  readonly rootDir?: string
  readonly fetch?: DecisionBackendDeps["fetch"]
}

export type CompletionContinuationDispatchController = {
  beginIdle(input: JevCompletionContinuationBeginInput): boolean
  finishHeuristic(sessionID: string, facts: CompletionContinuationHeuristicFacts): boolean
  markContinuationActivity(sessionID: string, successful: boolean): boolean
  humanIntervention(sessionID: string): number
  deleteSession(sessionID: string): void
  dispose(): Promise<void>
  inspect(): { readonly inFlight: number; readonly pendingDecisions: number }
}
export type CompletionContinuationDispatchOptions = {
  readonly backend: DecisionBackend
  readonly dispatcher: JevCompletionContinuationDispatcher
  readonly outcomes: CompletionContinuationOutcomeStore
  readonly diffCache: CompletionContinuationDiffCache
  readonly clock: JevCompletionContinuationClock
  readonly scheduler: JevCompletionContinuationScheduler
  readonly wireConfig: JevCompletionContinuationWireConfig
  readonly model: string
  readonly safeLog: (message: string, data?: unknown) => void
  readonly safeFlushCounters: () => void
}

const DEFAULT_CLOCK: JevCompletionContinuationClock = {
  now: Date.now,
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() }
  },
}

function disabledAdapter(): JevCompletionContinuation {
  const counters = emptyCompletionContinuationCounters()
  return {
    enabled: false,
    observeEvent() {},
    beginIdle: () => false,
    finishHeuristic: () => false,
    markContinuationActivity: () => false,
    humanIntervention: () => 0,
    deleteSession() {},
    getCounters: () => counters,
    inspect: () => ({ inFlight: 0, dispatchesDropped: 0, pendingDecisions: 0, diffSessions: 0 }),
    dispose: async () => {},
  }
}

export function createJevCompletionContinuation(
  options: CreateJevCompletionContinuationOptions,
): JevCompletionContinuation {
  const enabled = options.jevConfig?.enabled === true
    && options.jevConfig.wires.completion_continuation.enabled === true
  if (!enabled) return disabledAdapter()
  const logger = options.logger ?? log
  const safeLog = (message: string, data?: unknown): void => {
    try { logger(message, data) }
    catch (error) { if (!(error instanceof Error)) void String(error) }
  }

  try {
    const jevConfig = options.jevConfig
    const wireConfig = jevConfig.wires.completion_continuation
    const env = options.env ?? process.env
    const backend = options.backend ?? selectDecisionBackend({
      enabled: true,
      backend: jevConfig.backend,
      model: jevConfig.model,
      timeoutMs: wireConfig.timeout_ms,
    }, {
      apiKey: env.TYPESAFE_API_KEY,
      ...(env.OMO_JEV_BASE_URL === undefined ? {} : { baseURL: env.OMO_JEV_BASE_URL }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    const clock = options.clock ?? DEFAULT_CLOCK
    let counterReader = emptyCompletionContinuationCounters
    const sink = options.sink ?? createCompletionContinuationSink({
      rootDir: options.rootDir ?? join(homedir(), ".omo", "jev"),
      now: clock.now,
      getCounters: () => counterReader(),
      onWarning: safeLog,
    })
    const safeAppend = (entry: unknown): boolean => {
      try { return sink.append(entry) }
      catch (error) { safeLog("[jev] completion-continuation sink write failed", { error: String(error) }); return false }
    }
    const safeFlushCounters = (): void => {
      try { sink.flushCounters() }
      catch (error) { safeLog("[jev] completion-continuation counter flush failed", { error: String(error) }) }
    }
    const outcomes = createCompletionContinuationOutcomeStore({
      clock,
      outcomeWindowMs: wireConfig.outcome_window_ms,
      onEntry: safeAppend,
    })
    counterReader = outcomes.getCounters
    const diffCache = createCompletionContinuationDiffCache({ now: clock.now })
    const controller = createCompletionContinuationDispatchController({
      backend,
      dispatcher: options.dispatcher ?? decideCompletionContinuation,
      outcomes,
      diffCache,
      clock,
      scheduler: options.scheduler ?? scheduleCompletionContinuationBoulderSnapshot,
      wireConfig,
      model: jevConfig.model,
      safeLog,
      safeFlushCounters,
    })
    let disposePromise: Promise<void> | undefined
    return {
      enabled: true,
      observeEvent: (event) => { try { diffCache.observeEvent(event) } catch (error) { safeLog("[jev] completion-continuation event failed", { error: String(error) }) } },
      beginIdle: controller.beginIdle,
      finishHeuristic: controller.finishHeuristic,
      markContinuationActivity: controller.markContinuationActivity,
      humanIntervention: controller.humanIntervention,
      deleteSession: controller.deleteSession,
      getCounters: outcomes.getCounters,
      inspect: () => ({
        ...controller.inspect(),
        dispatchesDropped: outcomes.getCounters().dispatchesDropped,
        diffSessions: diffCache.inspect().sessionCount,
      }),
      dispose: () => {
        disposePromise ??= controller.dispose().then(() => {
          safeFlushCounters()
          try { sink.dispose() }
          catch (error) { safeLog("[jev] completion-continuation sink dispose failed", { error: String(error) }) }
        }, (error) => safeLog("[jev] completion-continuation dispose failed", { error: String(error) }))
        return disposePromise
      },
    }
  } catch (error) {
    safeLog("[jev] completion-continuation construction failed", { error: String(error) })
    return disabledAdapter()
  }
}
