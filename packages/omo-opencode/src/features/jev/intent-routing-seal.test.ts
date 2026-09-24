// allow: SIZE_OK - Seal timing, overlap amendment, persistence, and disposal form one state-machine scenario matrix.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

import type {
  IntentRoutingCounters,
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

import { JevConfigSchema } from "../../config/schema/jev"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared"
import {
  createIntentRoutingSink,
  readIntentRoutingSink,
  type IntentRoutingIntervalHandle,
} from "./intent-routing-sink"
import type {
  IntentRoutingScheduleTimeout,
  IntentRoutingTurnRecord,
  IntentRoutingTurnStoreOptions,
} from "./intent-routing-turn-store"

type SealMessageInput = {
  readonly sessionID: string
  readonly parts: readonly { readonly type?: string; readonly text?: string; readonly synthetic?: boolean }[]
  readonly questionVersion: number
  readonly vocabularyDigest: string
  readonly confidenceThreshold: number
  readonly configuredModelSpec: string
  readonly knownResolvedModel?: string
  readonly dispatch?: () => Promise<IntentRoutingDecisionResult>
  readonly notDispatchedReason?: string
}
type SealSink = {
  readonly processId: string
  readonly append: (entry: IntentRoutingEntry) => boolean | Promise<boolean>
  readonly updateCounters: (counters: IntentRoutingCounters) => void
  readonly getCounterEpoch: () => number
  readonly dispose: () => void
}
type SealController = {
  readonly onMessage: (input: SealMessageInput) => IntentRoutingTurnRecord | null
  readonly appendObservation: (input: {
    readonly sessionID: string
    readonly observation: IntentRoutingObservedDelegation
  }) => boolean
  readonly onSessionIdle: (sessionID: string) => boolean
  readonly onSessionDeleted: (sessionID: string) => void
  readonly getTurn: (sessionID: string, turnOrdinal: number) => IntentRoutingTurnRecord | undefined
  readonly listTurns: (sessionID: string) => readonly IntentRoutingTurnRecord[]
  readonly getCounters: () => IntentRoutingCounters
  readonly dispose: () => Promise<void>
}
type SealModule = {
  readonly createIntentRoutingSealController: (options: {
    readonly sink: SealSink
    readonly turnSealTimeoutMs: number
    readonly maxPromptChars?: number
    readonly now?: () => Date
    readonly scheduleSealTimeout?: IntentRoutingScheduleTimeout
    readonly scheduleFlushTimeout?: IntentRoutingScheduleTimeout
    readonly disposeFlushTimeoutMs?: number
    readonly storeOptions?: Omit<IntentRoutingTurnStoreOptions, "onCounterDelta" | "onFinalize" | "processId" | "counterEpoch">
  }) => SealController
  readonly isIntentRoutingHeadlineEligible: (record: IntentRoutingObservationRecord) => boolean
}

const modulePath: string = "./intent-routing-seal"
const loadedModule: unknown = await import(modulePath).catch(() => null)
const FIXED_DATE = new Date("2026-09-24T12:00:00.000Z")
const PROCESS_ID = "4200-1790251200000000000-sealproof"
const roots: string[] = []
const controllers: SealController[] = []

const OBSERVATION: IntentRoutingObservedDelegation = {
  tool: "task",
  category: "deep",
  subagentType: null,
  requestedSubagentType: null,
  taskId: null,
  normalizedCategory: "deep",
  normalizedSubagent: "none",
  routeClass: "category",
  callID: "call-late",
}

const NONE_RESULT: IntentRoutingDecisionResult = {
  predictionStatus: "filled",
  truncatedInput: false,
  answers: {
    intent: {
      choice: "question",
      confidence: 0.9,
      probabilities: { question: 0.9, implementation: 0.1 },
      valid: true,
      label: "would_apply",
    },
    category: {
      choice: "none",
      confidence: 0.95,
      probabilities: { none: 0.95, deep: 0.05 },
      valid: true,
      label: "would_apply",
    },
    subagent: {
      choice: "none",
      confidence: 0.95,
      probabilities: { none: 0.95, explore: 0.05 },
      valid: true,
      label: "would_apply",
    },
    ambiguous: { noul: 0.05, valid: true },
  },
  invalidAnswerCount: 0,
  unavailableReason: null,
  resolvedModel: "jev-2026-09-24",
  latencyMs: 9,
  threshold: 0.8,
  questionVersion: 1,
}

function requireSealModule(): SealModule {
  expect(
    loadedModule,
    "intent-routing seal module must exist before turns can be logically sealed and finalized",
  ).not.toBeNull()
  if (typeof loadedModule !== "object" || loadedModule === null) {
    throw new TypeError("intent-routing seal module is unavailable")
  }
  const create = Reflect.get(loadedModule, "createIntentRoutingSealController")
  const isHeadlineEligible = Reflect.get(loadedModule, "isIntentRoutingHeadlineEligible")
  expect(create, "createIntentRoutingSealController must be exported").toBeFunction()
  expect(isHeadlineEligible, "isIntentRoutingHeadlineEligible must be exported").toBeFunction()
  if (typeof create !== "function" || typeof isHeadlineEligible !== "function") {
    throw new TypeError("intent-routing seal exports are invalid")
  }
  return {
    createIntentRoutingSealController: create,
    isIntentRoutingHeadlineEligible: isHeadlineEligible,
  }
}

function manualScheduler(): {
  readonly schedule: IntentRoutingScheduleTimeout
  readonly delays: readonly number[]
  readonly fireLatest: () => void
} {
  const entries: Array<{ readonly callback: () => void; readonly delayMs: number; cancelled: boolean }> = []
  return {
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false }
      entries.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    get delays() { return entries.map(({ delayMs }) => delayMs) },
    fireLatest: () => entries.findLast(({ cancelled }) => !cancelled)?.callback(),
  }
}

function testHome(): string {
  const parent = process.env.HOME ?? "/tmp"
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "jev-intent-routing-seal-"))
  roots.push(root)
  return root
}

const noInterval = (): IntentRoutingIntervalHandle => ({ cancel: () => undefined })

function harness(): {
  readonly controller: SealController
  readonly sealScheduler: ReturnType<typeof manualScheduler>
  readonly sinkRoot: string
} {
  const sealScheduler = manualScheduler()
  const sink = createIntentRoutingSink({
    homeDir: testHome(),
    processId: PROCESS_ID,
    now: () => FIXED_DATE,
    scheduleInterval: noInterval,
  })
  const controller = requireSealModule().createIntentRoutingSealController({
    sink,
    turnSealTimeoutMs: 120_000,
    maxPromptChars: 8_000,
    now: () => FIXED_DATE,
    scheduleSealTimeout: sealScheduler.schedule,
  })
  controllers.push(controller)
  return { controller, sealScheduler, sinkRoot: dirname(sink.filePath) }
}

function message(text: string, sessionID = "session-main"): SealMessageInput {
  return {
    sessionID,
    parts: [{ type: "text", text }],
    questionVersion: 1,
    vocabularyDigest: "vocab-1",
    confidenceThreshold: 0.8,
    configuredModelSpec: "jev-2026-09-24",
    notDispatchedReason: "test-gate",
  }
}

function predictedNoneMessage(text: string): SealMessageInput {
  const input = message(text)
  return {
    sessionID: input.sessionID,
    parts: input.parts,
    questionVersion: input.questionVersion,
    vocabularyDigest: input.vocabularyDigest,
    confidenceThreshold: input.confidenceThreshold,
    configuredModelSpec: input.configuredModelSpec,
    dispatch: async () => NONE_RESULT,
  }
}

function observations(sinkRoot: string): readonly IntentRoutingObservationRecord[] {
  return readIntentRoutingSink(sinkRoot).entries.filter(
    (entry): entry is IntentRoutingObservationRecord => entry.kind === "observation",
  )
}

async function flushPredictions(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("intent-routing seal controller", () => {
  test("#given two real turns #when the successor arrives then idles #then next_turn and session_idle are the first seals", () => {
    const { controller } = harness()
    const first = controller.onMessage(message("turn one"))
    const second = controller.onMessage(message("turn two"))

    expect(controller.getTurn("session-main", first?.turnOrdinal ?? 0)?.sealedBy).toBe("next_turn")
    expect(controller.onSessionIdle("session-main")).toBe(true)

    expect(controller.getTurn("session-main", second?.turnOrdinal ?? 0)?.sealedBy).toBe("session_idle")
  })

  test("#given a live turn #when the distinct seal timeout fires #then seal_timeout is censored", () => {
    const { controller, sealScheduler, sinkRoot } = harness()
    controller.onMessage(message("timeout turn"))

    expect(sealScheduler.delays).toEqual([120_000])
    sealScheduler.fireLatest()

    expect(observations(sinkRoot)).toMatchObject([
      { sealedBy: "seal_timeout", correlationStatus: "censored" },
    ])
  })

  test("#given a live turn #when the controller disposes #then dispose is censored and flushed", async () => {
    const { controller, sinkRoot } = harness()
    controller.onMessage(message("dispose turn"))

    await controller.dispose()

    expect(observations(sinkRoot)).toMatchObject([
      { sealedBy: "dispose", correlationStatus: "censored" },
    ])
    expect(readIntentRoutingSink(sinkRoot).entries.some(({ kind }) => kind === "counter_delta")).toBe(true)
  })

  test("#given a live turn #when session.deleted arrives #then session_deleted seals and finalizes it", () => {
    const { controller, sinkRoot } = harness()
    controller.onMessage(message("deleted turn"))

    controller.onSessionDeleted("session-main")

    expect(observations(sinkRoot)).toMatchObject([
      { sealedBy: "session_deleted", correlationStatus: "reliable" },
    ])
  })

  test("#given a live turn #when a synthetic message arrives #then it neither seals nor creates a successor", () => {
    const { controller } = harness()
    const live = controller.onMessage(message("real turn"))

    const synthetic = controller.onMessage({
      ...message("ignored"),
      parts: [{ type: "text", text: `continue\n${OMO_INTERNAL_INITIATOR_MARKER}`, synthetic: true }],
    })

    expect(synthetic).toBeNull()
    expect(controller.listTurns("session-main")).toHaveLength(1)
    expect(controller.getTurn("session-main", live?.turnOrdinal ?? 0)?.sealedBy).toBeNull()
    expect(controller.getCounters().turnsSynthetic).toBe(1)
  })

  test("#given a timeout-sealed turn with no successor #when delegation arrives #then it is an orphan counter_delta", () => {
    const { controller, sealScheduler, sinkRoot } = harness()
    controller.onMessage(message("orphan turn"))
    sealScheduler.fireLatest()

    expect(controller.appendObservation({ sessionID: "session-main", observation: OBSERVATION })).toBe(false)

    const deltas = readIntentRoutingSink(sinkRoot).entries.filter((entry) => entry.kind === "counter_delta")
    expect(deltas.at(-1)?.counters.orphanObservations).toBe(1)
  })

  test("#given turn two logically seals turn one #when turn two idles #then turn one finalizes once with no rewrite path", () => {
    const { controller, sinkRoot } = harness()
    const first = controller.onMessage(message("turn one"))
    controller.onMessage(message("turn two"))

    expect(first?.sealedBy).toBeNull()
    expect(observations(sinkRoot)).toHaveLength(0)

    controller.onSessionIdle("session-main")
    const finalized = observations(sinkRoot)
    const counts = Map.groupBy(finalized, ({ turnOrdinal }) => turnOrdinal)

    expect(finalized).toHaveLength(2)
    expect(counts.get(1)).toHaveLength(1)
    expect(counts.get(2)).toHaveLength(1)
    expect("updateRecord" in controller).toBe(false)
  })

  test("#given an ordered overlap proof #when synthetic then successor then late delegation arrive #then both sides amend before finalization", () => {
    const { controller, sinkRoot } = harness()
    const first = controller.onMessage(message("turn one"))
    const synthetic = controller.onMessage({
      ...message("synthetic"),
      parts: [{ type: "text", text: "synthetic", synthetic: true }],
    })
    expect(synthetic).toBeNull()
    expect(controller.getTurn("session-main", first?.turnOrdinal ?? 0)?.sealedBy).toBeNull()

    const second = controller.onMessage(message("turn two"))
    expect(controller.getTurn("session-main", first?.turnOrdinal ?? 0)?.sealedBy).toBe("next_turn")
    expect(observations(sinkRoot)).toHaveLength(0)

    expect(controller.appendObservation({ sessionID: "session-main", observation: OBSERVATION })).toBe(true)
    const amendedFirst = controller.getTurn("session-main", first?.turnOrdinal ?? 0)
    const amendedSecond = controller.getTurn("session-main", second?.turnOrdinal ?? 0)
    expect(amendedFirst?.correlationStatus).toBe("overlap_ambiguous")
    expect(amendedSecond?.correlationStatus).toBe("overlap_ambiguous")
    expect(observations(sinkRoot)).toHaveLength(0)

    controller.onSessionIdle("session-main")
    const persisted = observations(sinkRoot)
    expect(persisted.map(({ correlationStatus }) => correlationStatus)).toEqual([
      "overlap_ambiguous",
      "overlap_ambiguous",
    ])
    expect(persisted.every((record) => !requireSealModule().isIntentRoutingHeadlineEligible(record))).toBe(true)
  })

  test("#given Jev predicts none and no delegation is observed #when the turn seals early #then apparent agreement is censored from headline rates", async () => {
    const { controller, sealScheduler, sinkRoot } = harness()
    controller.onMessage(predictedNoneMessage("answer directly"))
    await flushPredictions()

    sealScheduler.fireLatest()

    const record = observations(sinkRoot)[0]
    expect(record?.observed).toEqual([])
    expect(record?.answers?.category.choice).toBe("none")
    expect(record?.answers?.subagent.choice).toBe("none")
    expect(record?.correlationStatus).toBe("censored")
    expect(record === undefined ? true : requireSealModule().isIntentRoutingHeadlineEligible(record)).toBe(false)
  })

  test("#given finalized records #when read from the append-only sink #then every seal and status is set exactly once", () => {
    const { controller, sinkRoot } = harness()
    controller.onMessage(message("turn one"))
    controller.onMessage(message("turn two"))
    controller.onSessionIdle("session-main")

    const records = observations(sinkRoot)
    expect(records).toHaveLength(2)
    expect(records.every(({ sealedBy }) => sealedBy.length > 0)).toBe(true)
    expect(records.every(({ correlationStatus }) => correlationStatus.length > 0)).toBe(true)
    expect(new Set(records.map(({ turnOrdinal }) => turnOrdinal)).size).toBe(records.length)
  })

  test("#given a never-settling sink append #when dispose flushes #then its bounded timeout releases disposal", async () => {
    const flushScheduler = manualScheduler()
    let sinkDisposed = 0
    const sink: SealSink = {
      processId: PROCESS_ID,
      append: async () => new Promise<boolean>(() => undefined),
      updateCounters: () => undefined,
      getCounterEpoch: () => 0,
      dispose: () => { sinkDisposed += 1 },
    }
    const controller = requireSealModule().createIntentRoutingSealController({
      sink,
      turnSealTimeoutMs: 120_000,
      scheduleSealTimeout: manualScheduler().schedule,
      scheduleFlushTimeout: flushScheduler.schedule,
      disposeFlushTimeoutMs: 250,
    })
    controller.onMessage(message("bounded flush"))

    const disposing = controller.dispose()
    expect(flushScheduler.delays).toEqual([250])
    flushScheduler.fireLatest()
    await disposing

    expect(sinkDisposed).toBe(1)
  })
})

describe("Jev intent-routing timeout ordering", () => {
  test("#given seal timeout equal to or below prediction timeout #when parsed #then the strict refine rejects both", () => {
    const equal = JevConfigSchema.safeParse({
      wires: { intent_routing: { timeout_ms: 5_000, turn_seal_timeout_ms: 5_000 } },
    })
    const inverted = JevConfigSchema.safeParse({
      wires: { intent_routing: { timeout_ms: 5_000, turn_seal_timeout_ms: 1_000 } },
    })

    expect(equal.success).toBe(false)
    expect(inverted.success).toBe(false)
  })
})
