/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  choiceAnswer,
  createMockDecisionBackend,
  type DecisionBackend,
  type DecisionOutcome,
  type DecisionRequest,
  type Questions,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../config/schema/jev"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import { createJevModelErrorTriage, type JevModelErrorTriage } from "../features/jev"
import { createModelFallbackHook } from "../hooks/model-fallback/hook"
import {
  releaseAllPromptAsyncReservationsForTesting,
} from "../hooks/shared/prompt-async-gate"
import * as connectedProvidersCache from "../shared/connected-providers-cache"
import { shouldRetryError, type ErrorInfo } from "../shared/model-error-classifier"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createEventHandler } from "./event"
import type { EventInput } from "./event-types"

const TRIAGE_CHOICES = ["retry", "stop", "ignore"] as const
const RETRYABLE_ERROR = {
  name: "APIError",
  data: {
    message: "Bad Gateway: {\"error\":{\"message\":\"unknown provider for model claude-opus-4-8-thinking\"}}",
    isRetryable: true,
  },
}
const UNRELATED_ERROR = {
  name: "SomethingElse",
  data: { message: "an unrelated failure with no known pattern" },
}

type TestEventInput = { event: { type: string; properties?: unknown } }
type EventHandlerInput = Parameters<ReturnType<typeof createEventHandler>>[0]
type LogEntry = { readonly message: string; readonly data: unknown }
type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void }

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) throw new TypeError("Failed to create deferred promise")
  return { promise, resolve: resolvePromise }
}

function createDeferredBackend(callCount: number): {
  readonly backend: DecisionBackend
  readonly entered: readonly Promise<void>[]
  readonly release: (index: number) => void
  readonly decideCalls: () => number
} {
  const delegate = createMockDecisionBackend({
    triage: choiceAnswer("retry", 0.95, TRIAGE_CHOICES),
  })
  const calls = Array.from({ length: callCount }, () => ({
    entered: createDeferred(),
    release: createDeferred(),
  }))
  let decideCalls = 0
  const backend: DecisionBackend = {
    kind: "mock",
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
      const call = calls[decideCalls]
      if (!call) throw new TypeError(`Unexpected deferred decision call ${decideCalls + 1}`)
      decideCalls += 1
      call.entered.resolve()
      await call.release.promise
      return delegate.decide(request)
    },
  }
  return {
    backend,
    entered: calls.map((call) => call.entered.promise),
    release(index) {
      const call = calls[index]
      if (!call) throw new TypeError(`Missing deferred decision call ${index + 1}`)
      call.release.resolve()
    },
    decideCalls: () => decideCalls,
  }
}

function createLogs(): {
  readonly entries: LogEntry[]
  readonly logger: (message: string, data?: unknown) => void
} {
  const entries: LogEntry[] = []
  return {
    entries,
    logger(message, data) {
      entries.push({ message, data })
    },
  }
}

function createEnabledTriage(
  backend: DecisionBackend,
  logger?: (message: string, data?: unknown) => void,
): JevModelErrorTriage {
  return createJevModelErrorTriage({
    jevConfig: JevConfigSchema.parse({
      enabled: true,
      backend: "mock",
      wires: { model_error_triage: { enabled: true } },
    }),
    backend,
    logger,
  })
}

function createObservedTriage(triage: JevModelErrorTriage): {
  readonly triage: JevModelErrorTriage
  readonly shouldRetry: ReturnType<typeof mock<JevModelErrorTriage["shouldRetry"]>>
} {
  const shouldRetry = mock<JevModelErrorTriage["shouldRetry"]>((errorInfo, context) =>
    triage.shouldRetry(errorInfo, context))
  return {
    triage: { enabled: triage.enabled, shouldRetry },
    shouldRetry,
  }
}

function createAnswerTriage(
  choice: "retry" | "stop" | "ignore",
  confidence: number,
  logger?: (message: string, data?: unknown) => void,
): JevModelErrorTriage {
  return createEnabledTriage(
    createMockDecisionBackend({ triage: choiceAnswer(choice, confidence, TRIAGE_CHOICES) }),
    logger,
  )
}

function asEventHandlerInput(input: TestEventInput): EventHandlerInput {
  return unsafeTestValue<EventHandlerInput>(input)
}

function messageUpdatedEvent(sessionID: string, error: unknown = RETRYABLE_ERROR): TestEventInput {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_err_1",
          sessionID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          error,
          parentID: "msg_user_1",
          modelID: "claude-opus-4-8-thinking",
          providerID: "anthropic",
          mode: "Sisyphus - Ultraworker",
          agent: "Sisyphus - Ultraworker",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  }
}

function userMessageUpdatedEvent(sessionID: string): TestEventInput {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_user_1",
          sessionID,
          role: "user",
          modelID: "claude-opus-4-8-thinking",
          providerID: "anthropic",
          agent: "Sisyphus - Ultraworker",
        },
      },
    },
  }
}

function sessionErrorEvent(sessionID: string): TestEventInput {
  return {
    event: {
      type: "session.error",
      properties: {
        sessionID,
        providerID: "anthropic",
        modelID: "claude-opus-4-8-thinking",
        error: RETRYABLE_ERROR,
      },
    },
  }
}

function sessionStatusEvent(sessionID: string): TestEventInput {
  return {
    event: {
      type: "session.status",
      properties: {
        sessionID,
        status: {
          type: "retry",
          attempt: 1,
          message: RETRYABLE_ERROR.data.message,
          next: 1234,
        },
      },
    },
  }
}

function sessionDeletedEvent(sessionID: string): TestEventInput {
  return { event: { type: "session.deleted", properties: { info: { id: sessionID } } } }
}

let readConnectedProvidersCacheSpy: { mockRestore: () => void } | undefined
let readProviderModelsCacheSpy: { mockRestore: () => void } | undefined

function setupConnectedProviderCacheMocks(): void {
  readConnectedProvidersCacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(null)
  readProviderModelsCacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null)
}

describe("createEventHandler - Jev model fallback seam", () => {
  const createHandler = (args: {
    jevTriage: JevModelErrorTriage
    hooks: unknown
    monitorManager?: { stopSessionMonitors: (sessionID: string) => Promise<void> }
  }) => {
    setupConnectedProviderCacheMocks()
    const abortCalls: string[] = []
    const promptCalls: string[] = []
    const eventHandler = createEventHandler({
      ctx: unsafeTestValue({
        directory: "/tmp",
        client: {
          session: {
            abort: async ({ path }: { path: { id: string } }) => {
              abortCalls.push(path.id)
              return {}
            },
            prompt: async ({ path }: { path: { id: string } }) => {
              promptCalls.push(path.id)
              return {}
            },
          },
        },
      }),
      pluginConfig: unsafeTestValue({}),
      firstMessageVariantGate: {
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: unsafeTestValue({
        tmuxSessionManager: {
          onSessionCreated: async () => {},
          onSessionDeleted: async () => {},
        },
        skillMcpManager: { disconnectSession: async () => {} },
        ...(args.monitorManager ? { monitorManager: args.monitorManager } : {}),
      }),
      hooks: unsafeTestValue(args.hooks),
      jevTriage: args.jevTriage,
    })
    return {
      handler: (input: TestEventInput): Promise<void> => eventHandler(asEventHandlerInput(input)),
      abortCalls,
      promptCalls,
    }
  }

  afterEach(() => {
    readConnectedProvidersCacheSpy?.mockRestore()
    readProviderModelsCacheSpy?.mockRestore()
    readConnectedProvidersCacheSpy = undefined
    readProviderModelsCacheSpy = undefined
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("(A) disabled Jev leaves the heuristic path untouched and never calls the wire", async () => {
    const sessionID = "ses_jev_disabled"
    const shouldRetry = mock(async () => false)
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: { enabled: false, shouldRetry },
      hooks: { modelFallback: createModelFallbackHook() },
    })

    await handler(messageUpdatedEvent(sessionID))

    expect(abortCalls).toEqual([sessionID])
    expect(promptCalls).toEqual([sessionID])
    expect(shouldRetry).toHaveBeenCalledTimes(0)
  })

  test("(B) confident Jev ignore suppresses heuristic retry for message.updated", async () => {
    const sessionID = "ses_jev_ignore"
    const logs = createLogs()
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createAnswerTriage("ignore", 0.95, logs.logger),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    await handler(messageUpdatedEvent(sessionID))

    expect(abortCalls).toEqual([])
    expect(promptCalls).toEqual([])
    expect(logs.entries).toHaveLength(1)
    expect(logs.entries[0]).toMatchObject({
      message: "[jev] model-error-triage",
      data: { status: "applied", site: "message.updated", sessionID },
    })
  })

  test("(C) confident Jev retry adds a fallback for a heuristic-negative message.updated error", async () => {
    const sessionID = "ses_jev_add_retry"
    const errorInfo: ErrorInfo = { name: UNRELATED_ERROR.name, message: UNRELATED_ERROR.data.message }
    expect(shouldRetryError(errorInfo)).toBe(false)
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createAnswerTriage("retry", 0.95),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    await handler(messageUpdatedEvent(sessionID, UNRELATED_ERROR))

    expect(abortCalls).toEqual([sessionID])
    expect(promptCalls).toEqual([sessionID])
  })

  test("(D) below-threshold Jev ignore falls through to the retry heuristic", async () => {
    const sessionID = "ses_jev_low_confidence"
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createAnswerTriage("ignore", 0.5),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    await handler(messageUpdatedEvent(sessionID))

    expect(abortCalls).toEqual([sessionID])
    expect(promptCalls).toEqual([sessionID])
  })

  test("(E) unscripted Jev mock falls through to the retry heuristic", async () => {
    const sessionID = "ses_jev_unscripted"
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createEnabledTriage(createMockDecisionBackend({})),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    await handler(messageUpdatedEvent(sessionID))

    expect(abortCalls).toEqual([sessionID])
    expect(promptCalls).toEqual([sessionID])
  })

  test("(F) confident Jev ignore suppresses session.error and session.status at their own sites", async () => {
    const errorSessionID = "ses_jev_session_error"
    const statusSessionID = "ses_jev_session_status"
    const logs = createLogs()
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createAnswerTriage("ignore", 0.95, logs.logger),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    setMainSession(errorSessionID)
    await handler(sessionErrorEvent(errorSessionID))
    setMainSession(statusSessionID)
    await handler(sessionStatusEvent(statusSessionID))

    expect(abortCalls).toEqual([])
    expect(promptCalls).toEqual([])
    expect(logs.entries).toHaveLength(2)
    expect(logs.entries).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ site: "session.error" }) }),
      expect.objectContaining({ data: expect.objectContaining({ site: "session.status" }) }),
    ])
  })

  test("(G) concurrent duplicate message.updated events reserve once and dispatch once", async () => {
    const sessionID = "ses_jev_duplicate"
    const deferred = createDeferredBackend(1)
    const observed = createObservedTriage(createEnabledTriage(deferred.backend))
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
    })
    const payload = messageUpdatedEvent(sessionID)

    const both = Promise.all([handler(payload), handler(payload)])
    await deferred.entered[0]
    deferred.release(0)
    await both
    await handler(payload)

    expect(observed.shouldRetry).toHaveBeenCalledTimes(1)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H) session deletion cancels a pending decision before fallback state mutates", async () => {
    const sessionID = "ses_jev_deleted_pending"
    const logs = createLogs()
    const deferred = createDeferredBackend(1)
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createEnabledTriage(deferred.backend, logs.logger),
      hooks: { modelFallback: createModelFallbackHook() },
    })

    const pending = handler(messageUpdatedEvent(sessionID))
    await deferred.entered[0]
    await handler(sessionDeletedEvent(sessionID))
    deferred.release(0)
    await pending

    expect(promptCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(logs.entries).toHaveLength(1)
    expect(logs.entries[0]?.message).toBe("[jev] model-error-triage")
  })

  test("(H2) an old reservation finally cannot delete a newer reservation for the same key", async () => {
    const sessionID = "ses_jev_reservation_aba"
    const deferred = createDeferredBackend(2)
    const observed = createObservedTriage(createEnabledTriage(deferred.backend))
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
    })
    const payload = messageUpdatedEvent(sessionID)

    const first = handler(payload)
    await deferred.entered[0]
    await handler(sessionDeletedEvent(sessionID))
    const second = handler(payload)
    await deferred.entered[1]
    deferred.release(0)
    await first
    await handler(payload)
    expect(observed.shouldRetry).toHaveBeenCalledTimes(2)
    deferred.release(1)
    await second

    expect(observed.shouldRetry).toHaveBeenCalledTimes(2)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H3) deletion cancellation takes effect while monitor shutdown is blocked", async () => {
    const sessionID = "ses_jev_deletion_order"
    const deferred = createDeferredBackend(1)
    const stopEntered = createDeferred()
    const stopBlocked = createDeferred()
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createEnabledTriage(deferred.backend),
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: {
        stopSessionMonitors: () => {
          stopEntered.resolve()
          return stopBlocked.promise
        },
      },
    })

    const pending = handler(messageUpdatedEvent(sessionID))
    await deferred.entered[0]
    const deletion = handler(sessionDeletedEvent(sessionID))
    await stopEntered.promise
    deferred.release(0)
    await pending

    expect(promptCalls).toEqual([])
    expect(abortCalls).toEqual([])
    stopBlocked.resolve()
    await deletion
  })

  test("(H4) a new event is refused during deletion and accepted after deletion finishes", async () => {
    const sessionID = "ses_jev_event_during_deletion"
    const deferred = createDeferredBackend(2)
    const observed = createObservedTriage(createEnabledTriage(deferred.backend))
    const stopEntered = createDeferred()
    const stopBlocked = createDeferred()
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: {
        stopSessionMonitors: () => {
          stopEntered.resolve()
          return stopBlocked.promise
        },
      },
    })
    const payload = messageUpdatedEvent(sessionID)

    const pending = handler(payload)
    await deferred.entered[0]
    const deletion = handler(sessionDeletedEvent(sessionID))
    await stopEntered.promise
    await handler(payload)
    expect(observed.shouldRetry).toHaveBeenCalledTimes(1)
    expect(promptCalls).toEqual([])
    expect(abortCalls).toEqual([])
    deferred.release(0)
    await pending
    stopBlocked.resolve()
    await deletion
    const accepted = handler(payload)
    await deferred.entered[1]
    deferred.release(1)
    await accepted

    expect(observed.shouldRetry).toHaveBeenCalledTimes(2)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H5a) rejecting monitor shutdown does not leak a deletion marker without a reservation", async () => {
    const sessionID = "ses_jev_monitor_reject_empty"
    const observed = createObservedTriage(createAnswerTriage("retry", 0.95))
    const { handler } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: { stopSessionMonitors: () => Promise.reject(new Error("monitor boom")) },
    })

    await expect(handler(sessionDeletedEvent(sessionID))).rejects.toThrow("monitor boom")
    await handler(messageUpdatedEvent(sessionID))

    expect(observed.shouldRetry).toHaveBeenCalledTimes(1)
  })

  test("(H5b) rejecting monitor shutdown cancels a reservation without leaking the deletion marker", async () => {
    const sessionID = "ses_jev_monitor_reject_pending"
    const deferred = createDeferredBackend(2)
    const observed = createObservedTriage(createEnabledTriage(deferred.backend))
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: { stopSessionMonitors: () => Promise.reject(new Error("monitor boom")) },
    })
    const payload = messageUpdatedEvent(sessionID)

    const pending = handler(payload)
    await deferred.entered[0]
    await expect(handler(sessionDeletedEvent(sessionID))).rejects.toThrow("monitor boom")
    deferred.release(0)
    await pending
    expect(promptCalls).toEqual([])
    const next = handler(payload)
    await deferred.entered[1]
    deferred.release(1)
    await next

    expect(observed.shouldRetry).toHaveBeenCalledTimes(2)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H5c) refused session.status retry does not poison dedupe while deletion is blocked", async () => {
    const sessionID = "ses_jev_status_deletion_dedupe"
    const observed = createObservedTriage(createAnswerTriage("retry", 0.95))
    const stopEntered = createDeferred()
    const stopBlocked = createDeferred()
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: {
        stopSessionMonitors: () => {
          stopEntered.resolve()
          return stopBlocked.promise
        },
      },
    })
    const payload = sessionStatusEvent(sessionID)

    setMainSession(sessionID)
    const deletion = handler(sessionDeletedEvent(sessionID))
    await stopEntered.promise
    await handler(payload)
    expect(observed.shouldRetry).toHaveBeenCalledTimes(0)
    stopBlocked.resolve()
    await deletion
    setMainSession(sessionID)
    await handler(payload)

    expect(observed.shouldRetry).toHaveBeenCalledTimes(1)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H5d) cancelled session.status retry remains triageable after rejecting monitor shutdown", async () => {
    const sessionID = "ses_jev_status_reject_dedupe"
    const deferred = createDeferredBackend(2)
    const observed = createObservedTriage(createEnabledTriage(deferred.backend))
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: { stopSessionMonitors: () => Promise.reject(new Error("monitor boom")) },
    })
    const payload = sessionStatusEvent(sessionID)

    setMainSession(sessionID)
    await handler(userMessageUpdatedEvent(sessionID))
    const first = handler(payload)
    await deferred.entered[0]
    await expect(handler(sessionDeletedEvent(sessionID))).rejects.toThrow("monitor boom")
    deferred.release(0)
    await first
    const second = handler(payload)
    await deferred.entered[1]
    deferred.release(1)
    await second

    expect(observed.shouldRetry).toHaveBeenCalledTimes(2)
    expect(promptCalls).toEqual([sessionID])
  })

  test("(H6) deletion cancels a reservation before the first event hook can block", async () => {
    const sessionID = "ses_jev_cancel_before_hooks"
    const deferred = createDeferredBackend(1)
    const hookEntered = createDeferred()
    const hookBlocked = createDeferred()
    const { handler, abortCalls, promptCalls } = createHandler({
      jevTriage: createEnabledTriage(deferred.backend),
      hooks: {
        modelFallback: createModelFallbackHook(),
        autoUpdateChecker: {
          event: (input: EventInput) => {
            if (input.event.type !== "session.deleted") return undefined
            hookEntered.resolve()
            return hookBlocked.promise
          },
        },
      },
    })

    const pending = handler(messageUpdatedEvent(sessionID))
    await deferred.entered[0]
    const deletion = handler(sessionDeletedEvent(sessionID))
    await hookEntered.promise
    deferred.release(0)
    await pending

    expect(promptCalls).toEqual([])
    expect(abortCalls).toEqual([])
    hookBlocked.resolve()
    await deletion
  })

  test("(H7) overlapping deletions keep the session refused until the last deletion finishes", async () => {
    const sessionID = "ses_jev_overlapping_deletions"
    const observed = createObservedTriage(createAnswerTriage("retry", 0.95))
    const stopEntered = [createDeferred(), createDeferred()]
    const stopBlocked = [createDeferred(), createDeferred()]
    let stopCalls = 0
    const { handler, promptCalls } = createHandler({
      jevTriage: observed.triage,
      hooks: { modelFallback: createModelFallbackHook() },
      monitorManager: {
        stopSessionMonitors: () => {
          const index = stopCalls
          stopCalls += 1
          const entered = stopEntered[index]
          const blocked = stopBlocked[index]
          if (!entered || !blocked) return Promise.reject(new TypeError("Unexpected monitor stop call"))
          entered.resolve()
          return blocked.promise
        },
      },
    })
    const payload = messageUpdatedEvent(sessionID)

    const firstDeletion = handler(sessionDeletedEvent(sessionID))
    const secondDeletion = handler(sessionDeletedEvent(sessionID))
    await Promise.all([stopEntered[0]?.promise, stopEntered[1]?.promise])
    stopBlocked[0]?.resolve()
    await firstDeletion
    await handler(payload)
    expect(observed.shouldRetry).toHaveBeenCalledTimes(0)
    stopBlocked[1]?.resolve()
    await secondDeletion
    await handler(payload)

    expect(observed.shouldRetry).toHaveBeenCalledTimes(1)
    expect(promptCalls).toEqual([sessionID])
  })
})
