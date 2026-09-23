// allow: SIZE_OK - adapter cases share one injected backend/heuristic/logger harness for the degradation paths; future additions should split by failure class.

import { describe, expect, mock, test } from "bun:test"
import {
  choiceAnswer,
  createMockDecisionBackend,
  type DecisionBackend,
  type DecisionOutcome,
  type Questions,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema, type JevConfig } from "../../config/schema/jev"
import type { ErrorInfo } from "../../shared/model-error-classifier"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createJevModelErrorTriage } from "./model-error-triage"

const TRIAGE_CHOICES = ["retry", "stop", "ignore"] as const
const RETRYABLE_ERROR: ErrorInfo = {
  name: "ratelimiterror",
  message: "rate limit from provider",
}

type LogEntry = {
  readonly message: string
  readonly data: unknown
}

function enabledConfig(backend: "mock" | "real" = "mock"): JevConfig {
  return JevConfigSchema.parse({
    enabled: true,
    backend,
    model: "jev-test",
    timeout_ms: 1500,
    wires: { model_error_triage: { enabled: true, confidence_threshold: 0.8 } },
  })
}

function logCollector(): {
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

function expectOnlyLog(
  entries: readonly LogEntry[],
  message: string,
  data: Readonly<Record<string, unknown>>,
): void {
  expect(entries).toHaveLength(1)
  expect(entries[0]?.message).toBe(message)
  expect(entries[0]?.data).toMatchObject(data)
}

describe("createJevModelErrorTriage", () => {
  test("#given disabled config #when triaging #then enabled is false, no line is logged, and the heuristic decides", async () => {
    const logs = logCollector()
    const heuristic = mock(() => true)
    const backend = unsafeTestValue<DecisionBackend>({
      get kind() {
        throw new Error("disabled backend must not be inspected")
      },
    })
    const triage = createJevModelErrorTriage({
      jevConfig: JevConfigSchema.parse({
        enabled: false,
        backend: "real",
        wires: { model_error_triage: { enabled: true } },
      }),
      backend,
      heuristic,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "message.updated",
      sessionID: "disabled-session",
    })

    expect(triage.enabled).toBe(false)
    expect(shouldRetry).toBe(true)
    expect(heuristic).toHaveBeenCalledTimes(1)
    expect(logs.entries).toEqual([])
  })

  test("#given enabled triage and confident applied ignore #when the heuristic would retry #then Jev returns false and logs the decision", async () => {
    const logs = logCollector()
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend: createMockDecisionBackend({
        triage: choiceAnswer("ignore", 0.95, TRIAGE_CHOICES),
      }),
      heuristic: () => true,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "message.updated",
      sessionID: "applied-session",
    })

    expect(triage.enabled).toBe(true)
    expect(shouldRetry).toBe(false)
    expectOnlyLog(logs.entries, "[jev] model-error-triage", {
      wire: "model_error_triage",
      questionVersion: 1,
      site: "message.updated",
      sessionID: "applied-session",
      backend: "mock",
      status: "applied",
      reason: null,
      choice: "ignore",
      confidence: 0.95,
      probabilities: expect.any(Object),
      threshold: 0.8,
      model: "mock",
      latencyMs: expect.any(Number),
      heuristicShouldRetry: true,
      shouldRetry: false,
      errorName: "ratelimiterror",
      errorMessageHead: "rate limit from provider",
    })
  })

  test("#given enabled triage and an unscripted mock #when triaging #then the heuristic value falls through with an unscripted line", async () => {
    const logs = logCollector()
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend: createMockDecisionBackend({}),
      heuristic: () => true,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "session.status",
      sessionID: "unscripted-session",
    })

    expect(shouldRetry).toBe(true)
    expectOnlyLog(logs.entries, "[jev] model-error-triage", {
      wire: "model_error_triage",
      site: "session.status",
      sessionID: "unscripted-session",
      backend: "mock",
      status: "fell_through",
      reason: "unscripted",
      choice: null,
    })
  })

  test("#given enabled triage and a rejecting decide #when triaging #then transport_error uses one normal fell-through line", async () => {
    const logs = logCollector()
    const backend: DecisionBackend = {
      kind: "mock",
      async decide<Q extends Questions>(): Promise<DecisionOutcome<Q>> {
        throw new TypeError("transport failed")
      },
    }
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend,
      heuristic: () => false,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry({ message: "unknown failure" }, {
      site: "session.error",
      sessionID: "rejecting-session",
    })

    expect(shouldRetry).toBe(false)
    expectOnlyLog(logs.entries, "[jev] model-error-triage", {
      wire: "model_error_triage",
      site: "session.error",
      sessionID: "rejecting-session",
      backend: "mock",
      status: "fell_through",
      reason: "transport_error",
    })
  })

  test("#given enabled triage and a throwing kind getter #when triaging #then the adapter fallback returns the heuristic and logs one failed line", async () => {
    const logs = logCollector()
    const decide = mock(async () => {
      throw new Error("unreachable")
    })
    const backend = unsafeTestValue<DecisionBackend>({
      get kind() {
        throw new Error("boom")
      },
      decide,
    })
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend,
      heuristic: () => true,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "session.error",
      sessionID: "unsafe-kind-session",
    })

    expect(shouldRetry).toBe(true)
    expect(decide).toHaveBeenCalledTimes(0)
    expectOnlyLog(logs.entries, "[jev] model-error-triage failed; using heuristic", {
      wire: "model_error_triage",
      site: "session.error",
      sessionID: "unsafe-kind-session",
      backend: "unknown",
      error: "Error: boom",
    })
  })

  test("#given enabled triage and a throwing heuristic #when triaging #then the same error rejects after exactly one call and zero log lines", async () => {
    const logs = logCollector()
    const failure = new TypeError("heuristic failed")
    const heuristic = mock(() => {
      throw failure
    })
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend: createMockDecisionBackend({}),
      heuristic,
      logger: logs.logger,
    })

    const result = triage.shouldRetry(RETRYABLE_ERROR, {
      site: "session.status",
      sessionID: "heuristic-session",
    })

    await expect(result).rejects.toBe(failure)
    expect(heuristic).toHaveBeenCalledTimes(1)
    expect(logs.entries).toEqual([])
  })

  test("#given a confident ignore and a throwing logger #when triaging #then the applied false decision still resolves", async () => {
    const throwingLogger = mock(() => {
      throw new Error("logger failed")
    })
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig(),
      backend: createMockDecisionBackend({
        triage: choiceAnswer("ignore", 0.95, TRIAGE_CHOICES),
      }),
      heuristic: () => true,
      logger: throwingLogger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "message.updated",
      sessionID: "throwing-logger-session",
    })

    expect(shouldRetry).toBe(false)
    expect(throwingLogger).toHaveBeenCalledTimes(1)
  })

  test("#given real backend config and a missing key #when triaging #then no network path is reached and missing_api_key falls through", async () => {
    const logs = logCollector()
    const triage = createJevModelErrorTriage({
      jevConfig: enabledConfig("real"),
      env: {},
      heuristic: () => true,
      logger: logs.logger,
    })

    const shouldRetry = await triage.shouldRetry(RETRYABLE_ERROR, {
      site: "session.status",
      sessionID: "missing-key-session",
    })

    expect(shouldRetry).toBe(true)
    expectOnlyLog(logs.entries, "[jev] model-error-triage", {
      wire: "model_error_triage",
      site: "session.status",
      sessionID: "missing-key-session",
      backend: "real",
      status: "fell_through",
      reason: "missing_api_key",
    })
  })
})
