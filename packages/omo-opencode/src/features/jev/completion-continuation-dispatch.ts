import {
  COMPLETION_CONTINUATION_QUESTION_VERSION,
  buildCompletionContinuationState,
  type CompletionContinuationDecisionResult,
  type CompletionContinuationHeuristicFacts,
  type CompletionContinuationInputTruncations,
} from "@oh-my-opencode/jev-core"
import {
  captureCompletionContinuationInput,
  finalizeCompletionContinuationInput,
  type CompletionContinuationInputSnapshot,
} from "./completion-continuation-input"
import type { CompletionContinuationOutcomeHandle } from "./completion-continuation-outcome-types"
import { readCompletionContinuationPreviousState } from "./completion-continuation-previous"
import type {
  CompletionContinuationDispatchController,
  CompletionContinuationDispatchOptions,
  JevCompletionContinuationBeginInput,
} from "./completion-continuation"

type FinalizedInput = {
  readonly snapshot: CompletionContinuationInputSnapshot
  readonly state: ReturnType<typeof buildCompletionContinuationState>
  readonly inputTruncations: CompletionContinuationInputTruncations
}

type PendingDecision = {
  readonly sessionID: string
  readonly snapshot: CompletionContinuationInputSnapshot
  readonly isContinuationCandidate: boolean
  heuristicFacts?: CompletionContinuationHeuristicFacts
  finalized?: FinalizedInput
  task?: { cancel(): void }
}

function failedResult(
  threshold: number,
  latencyMs: number,
  reason: "transport_error" | "malformed_response",
): CompletionContinuationDecisionResult {
  return {
    predictionStatus: "failed",
    unavailableReason: reason,
    resolvedModel: null,
    latencyMs,
    probabilities: { actuallyComplete: null, progressing: null, stuck: null },
    thresholdLabels: {
      actuallyComplete: "unavailable",
      progressing: "unavailable",
      stuck: "unavailable",
    },
    invalidAnswerCount: 0,
    threshold,
    questionVersion: COMPLETION_CONTINUATION_QUESTION_VERSION,
  }
}

export function createCompletionContinuationDispatchController(
  options: CompletionContinuationDispatchOptions,
): CompletionContinuationDispatchController {
  const pending = new Map<string, PendingDecision>()
  const latest = new Map<string, CompletionContinuationOutcomeHandle>()
  const activeDispatches = new Set<number>()
  let dispatchSequence = 0
  let disposing = false

  const resolveSafely = (
    handle: CompletionContinuationOutcomeHandle,
    result: CompletionContinuationDecisionResult,
  ): void => {
    if (disposing) return
    try {
      options.outcomes.resolvePrediction(handle, result)
    } catch (error) {
      options.safeLog("[jev] completion-continuation write failed", { error: String(error) })
    }
  }

  const dispatch = (
    handle: CompletionContinuationOutcomeHandle,
    finalized: FinalizedInput,
  ): void => {
    dispatchSequence += 1
    const dispatchID = dispatchSequence
    activeDispatches.add(dispatchID)
    const startedAt = options.clock.now()
    const decisionClock = {
      now: options.clock.now,
      schedule: (delayMs: number, callback: () => void) => {
        const timer = options.clock.schedule(delayMs, callback)
        timer.unref()
        return timer
      },
    }
    void Promise.resolve()
      .then(() => options.dispatcher({
        backend: options.backend,
        state: finalized.state.state,
        confidenceThreshold: options.wireConfig.confidence_threshold,
        timeoutMs: options.wireConfig.timeout_ms,
        model: options.model,
        clock: decisionClock,
      }))
      .then(
        (result) => resolveSafely(handle, result),
        (error) => {
          options.safeLog("[jev] completion-continuation dispatch failed", {
            error: String(error).slice(0, 200),
          })
          resolveSafely(handle, failedResult(
            options.wireConfig.confidence_threshold,
            options.clock.now() - startedAt,
            "transport_error",
          ))
        },
      )
      .finally(() => { activeDispatches.delete(dispatchID) })
      .catch((error) => {
        activeDispatches.delete(dispatchID)
        options.safeLog("[jev] completion-continuation settle failed", { error: String(error) })
      })
  }

  const launch = (decision: PendingDecision): void => {
    const finalized = decision.finalized
    const heuristicFacts = decision.heuristicFacts
    if (finalized === undefined || heuristicFacts === undefined || disposing) return
    pending.delete(decision.sessionID)
    try {
      const handle = options.outcomes.start({
        sessionID: decision.sessionID,
        snapshot: finalized.snapshot,
        inputTruncations: finalized.inputTruncations,
        heuristicFacts,
        isContinuationCandidate: decision.isContinuationCandidate,
        confidenceThreshold: options.wireConfig.confidence_threshold,
      })
      latest.set(decision.sessionID, handle)
      options.outcomes.finalizeHeuristic(handle, heuristicFacts)
      if (finalized.state.serializedBytes > options.wireConfig.max_state_bytes) {
        resolveSafely(handle, failedResult(
          options.wireConfig.confidence_threshold,
          0,
          "malformed_response",
        ))
        return
      }
      if (activeDispatches.size >= options.wireConfig.max_inflight) {
        options.outcomes.markPredictionNotDispatched(handle, "max_inflight")
        options.safeFlushCounters()
        return
      }
      dispatch(handle, finalized)
    } catch (error) {
      options.safeLog("[jev] completion-continuation launch failed", { error: String(error) })
    }
  }

  const beginIdle = (input: JevCompletionContinuationBeginInput): boolean => {
    if (disposing) return false
    try {
      pending.get(input.sessionID)?.task?.cancel()
      const previous = readCompletionContinuationPreviousState(options.outcomes, input.sessionID)
      const snapshot = captureCompletionContinuationInput({
        todos: input.todos,
        transcript: input.transcript,
        diff: options.diffCache.getSnapshot(input.sessionID),
        now: options.clock.now,
      })
      const decision: PendingDecision = {
        sessionID: input.sessionID,
        snapshot,
        isContinuationCandidate: input.isContinuationCandidate,
      }
      pending.set(input.sessionID, decision)
      const task = options.scheduler({
        directory: input.directory,
        now: options.clock.now,
        onSnapshot: (boulder) => {
          try {
            if (disposing || pending.get(input.sessionID) !== decision) return
            const finalizedSnapshot = finalizeCompletionContinuationInput(snapshot, boulder)
            const state = buildCompletionContinuationState({ ...finalizedSnapshot.input, previous })
            decision.finalized = {
              snapshot: finalizedSnapshot,
              state,
              inputTruncations: {
                ...state.state.inputTruncations,
                boulderContent: state.state.inputTruncations.boulderContent || boulder.titleTruncated,
              },
            }
            launch(decision)
          } catch (error) {
            pending.delete(input.sessionID)
            options.safeLog("[jev] completion-continuation state build failed", { error: String(error) })
          }
        },
      })
      if (pending.get(input.sessionID) === decision) decision.task = task
      else task.cancel()
      return true
    } catch (error) {
      pending.delete(input.sessionID)
      options.safeLog("[jev] completion-continuation scheduling failed", { error: String(error) })
      return false
    }
  }

  return {
    beginIdle,
    finishHeuristic: (sessionID, facts) => {
      const decision = pending.get(sessionID)
      if (decision === undefined || disposing) return false
      decision.heuristicFacts = facts
      launch(decision)
      return true
    },
    markContinuationActivity: (sessionID, successful) => {
      const handle = latest.get(sessionID)
      if (handle === undefined || disposing) return false
      try { return options.outcomes.markContinuationActivity(handle, { successful }) }
      catch (error) { options.safeLog("[jev] completion-continuation activity failed", { error: String(error) }); return false }
    },
    humanIntervention: (sessionID) => {
      try { return disposing ? 0 : options.outcomes.humanIntervention(sessionID) }
      catch (error) { options.safeLog("[jev] completion-continuation intervention failed", { error: String(error) }); return 0 }
    },
    deleteSession: (sessionID) => {
      pending.get(sessionID)?.task?.cancel()
      pending.delete(sessionID)
      latest.delete(sessionID)
      options.diffCache.deleteSession(sessionID)
      if (!disposing) void options.outcomes.deleteSession(sessionID).catch((error) => options.safeLog("[jev] completion-continuation delete failed", { error: String(error) }))
    },
    dispose: async () => {
      disposing = true
      for (const decision of pending.values()) decision.task?.cancel()
      pending.clear()
      latest.clear()
      activeDispatches.clear()
      try { await options.outcomes.dispose() }
      catch (error) { options.safeLog("[jev] completion-continuation dispose failed", { error: String(error) }) }
    },
    inspect: () => ({ inFlight: activeDispatches.size, pendingDecisions: pending.size }),
  }
}
