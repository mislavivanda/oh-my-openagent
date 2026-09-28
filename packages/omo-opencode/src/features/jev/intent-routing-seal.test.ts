import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type {
  IntentRoutingDecisionResult,
  IntentRoutingEntry,
  IntentRoutingObservationRecord,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"
import { JevConfigSchema } from "../../config/schema/jev"
import { createIntentRoutingSeal } from "./intent-routing-seal"
import { createIntentRoutingSink, readIntentRoutingSink } from "./intent-routing-sink"
import type { IntentRoutingTurnInput } from "./intent-routing-turn-store"

const SESSION_ID = "seal-session"
const RECORDED_AT = "2026-09-24T12:00:00.000Z"
const TURN_SEAL_TIMEOUT_MS = 120_000
const PREDICTION_TIMEOUT_MS = 2_500
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
  unavailableReason: null,
  resolvedModel: "jev-1.13.0",
  latencyMs: 5,
  truncatedInput: false,
  answers: {
    intent: { choice: "implementation", confidence: 0.9, probabilities: { implementation: 0.9, research: 0.1 }, valid: true },
    category: { choice: "none", confidence: 0.9, probabilities: { none: 0.9, deep: 0.1 }, valid: true },
    subagent: { choice: "none", confidence: 0.9, probabilities: { none: 0.9, explore: 0.1 }, valid: true },
    ambiguous: { noul: 0.1, valid: true },
  },
  labels: { intent: "would_apply", category: "would_fall_through", subagent: "would_fall_through" },
  invalidAnswerCount: 0,
  questionVersion: 1,
}

type ScheduledCall = { readonly delayMs: number; readonly run: () => void; cancelled: boolean }

function createScheduler() {
  const calls: ScheduledCall[] = []
  return {
    calls,
    schedule(run: () => void, delayMs: number) {
      const call = { delayMs, run, cancelled: false }
      calls.push(call)
      return { cancel: () => { call.cancelled = true } }
    },
    fire(delayMs: number) {
      const call = calls.find((candidate) => candidate.delayMs === delayMs && !candidate.cancelled)
      if (call === undefined) throw new Error(`No active timer for ${delayMs}ms`)
      call.cancelled = true
      call.run()
    },
  }
}

const tempHomes: string[] = []
let harnessSequence = 0

function turnInput(text: string, overrides: Partial<IntentRoutingTurnInput> = {}): IntentRoutingTurnInput {
  return {
    sessionID: SESSION_ID,
    parts: [{ type: "text", text }],
    questionVersion: 1,
    vocabularyDigest: "vocab-a",
    confidenceThreshold: 0.8,
    configuredModelSpec: "jev-1.13.0",
    predictionTimeoutMs: PREDICTION_TIMEOUT_MS,
    truncatedInput: false,
    notDispatchedReason: "test",
    ...overrides,
  }
}

function createHarness() {
  harnessSequence += 1
  const home = mkdtempSync(join(tmpdir(), "jev-seal-home-"))
  tempHomes.push(home)
  const directory = join(home, ".omo", "jev")
  const sink = createIntentRoutingSink({
    directory,
    identity: { pid: 9000 + harnessSequence, processStartEpochNanos: 1n, randomSuffix: `seal${harnessSequence}` },
    now: () => new Date(RECORDED_AT),
  })
  const scheduler = createScheduler()
  const seal = createIntentRoutingSeal({
    maxTrackedSessions: 4,
    maxTurnsPerSession: 4,
    processId: sink.processId,
    sink: (entry) => sink.write(entry),
    disposeSink: () => sink.dispose(),
    now: () => new Date(RECORDED_AT),
    turnSealTimeoutMs: TURN_SEAL_TIMEOUT_MS,
    disposeFlushTimeoutMs: 50,
    schedule: scheduler.schedule,
  })
  return { directory, scheduler, seal, sink }
}

function observations(directory: string): readonly IntentRoutingObservationRecord[] {
  return readIntentRoutingSink({ directory }).entries.filter(
    (entry): entry is IntentRoutingObservationRecord => entry.kind === "observation",
  )
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe("createIntentRoutingSeal", () => {
  test("#given turn one is live #when turn two arrives #then next_turn seals without finalizing until turn two seals", () => {
    const { directory, seal } = createHarness()
    const first = seal.handleMessage(turnInput("turn one"))

    const second = seal.handleMessage(turnInput("turn two"))

    expect(seal.getTurn(SESSION_ID, first?.turnOrdinal ?? 0)?.sealedBy).toBe("next_turn")
    expect(observations(directory)).toHaveLength(0)
    seal.handleSessionIdle(SESSION_ID)
    const records = observations(directory)
    expect(records.filter((record) => record.turnOrdinal === first?.turnOrdinal)).toHaveLength(1)
    expect(records.find((record) => record.turnOrdinal === first?.turnOrdinal)?.sealedBy).toBe("next_turn")
    expect(records.find((record) => record.turnOrdinal === second?.turnOrdinal)?.sealedBy).toBe("session_idle")
  })

  test("#given a live turn #when session.idle fires first #then it seals reliably by session_idle", () => {
    const { directory, seal } = createHarness()
    seal.handleMessage(turnInput("idle path"))

    seal.handleSessionIdle(SESSION_ID)

    expect(observations(directory)[0]).toMatchObject({ sealedBy: "session_idle", correlationStatus: "reliable" })
  })

  test("#given a deferred predecessor #when session.deleted closes the session #then the predecessor keeps its first seal reason", () => {
    const { directory, seal } = createHarness()
    seal.handleMessage(turnInput("turn one"))
    seal.handleMessage(turnInput("turn two"))

    seal.handleSessionDeleted(SESSION_ID)

    expect(observations(directory).map((record) => record.sealedBy)).toEqual(["next_turn", "session_deleted"])
  })

  test("#given a live turn #when the distinct seal timer fires #then it seals censored by seal_timeout", () => {
    const { directory, scheduler, seal } = createHarness()
    seal.handleMessage(turnInput("timeout path"))
    expect(scheduler.calls.some((call) => call.delayMs === TURN_SEAL_TIMEOUT_MS)).toBe(true)
    expect(scheduler.calls.some((call) => call.delayMs === PREDICTION_TIMEOUT_MS)).toBe(false)

    scheduler.fire(TURN_SEAL_TIMEOUT_MS)

    expect(observations(directory)[0]).toMatchObject({ sealedBy: "seal_timeout", correlationStatus: "censored" })
  })

  test("#given a pending prediction #when dispose fires #then it forces timeout, seals censored, and bounds the write flush", async () => {
    const prediction = new Promise<IntentRoutingDecisionResult>(() => {})
    const write = new Promise<void>(() => {})
    const entries: IntentRoutingEntry[] = []
    const scheduler = createScheduler()
    const seal = createIntentRoutingSeal({
      maxTrackedSessions: 2,
      maxTurnsPerSession: 2,
      processId: "dispose-test",
      sink: (entry) => { entries.push(entry); return write },
      turnSealTimeoutMs: TURN_SEAL_TIMEOUT_MS,
      disposeFlushTimeoutMs: 50,
      schedule: scheduler.schedule,
    })
    seal.handleMessage(turnInput("dispose path", { dispatch: () => prediction }))

    const disposing = seal.dispose()
    scheduler.fire(50)
    await disposing

    expect(entries.find((entry) => entry.kind === "observation")).toMatchObject({
      sealedBy: "dispose",
      correlationStatus: "censored",
      predictionStatus: "timeout",
    })
  })

  test("#given a live turn #when a synthetic message arrives #then the turn remains live and no successor is created", () => {
    const { seal } = createHarness()
    const first = seal.handleMessage(turnInput("real turn"))

    const synthetic = seal.handleMessage(turnInput("internal", { parts: [{ type: "text", text: "internal", synthetic: true }] }))

    expect(synthetic).toBeUndefined()
    expect(seal.listTurns(SESSION_ID)).toHaveLength(1)
    expect(seal.getTurn(SESSION_ID, first?.turnOrdinal ?? 0)?.sealedBy).toBeNull()
  })

  test("#given a sealed turn with no successor #when a delegation arrives #then it is orphaned through counter_delta", () => {
    const { directory, seal } = createHarness()
    seal.handleMessage(turnInput("orphan path"))
    seal.handleSessionIdle(SESSION_ID)

    const appended = seal.appendObservation(SESSION_ID, OBSERVATION)

    expect(appended).toBe(false)
    expect(readIntentRoutingSink({ directory }).counters.orphanObservations).toBe(1)
  })

  test("#given turn two exists #when a late observation follows the next_turn seal #then both sides are amended before one-time append", () => {
    const { directory, seal, sink } = createHarness()
    const first = seal.handleMessage(turnInput("turn one"))
    expect(seal.handleMessage(turnInput("synthetic", { parts: [{ type: "text", text: "synthetic", synthetic: true }] }))).toBeUndefined()
    const second = seal.handleMessage(turnInput("turn two"))

    expect(seal.appendObservation(SESSION_ID, OBSERVATION)).toBe(true)
    expect(seal.getTurn(SESSION_ID, first?.turnOrdinal ?? 0)?.correlationStatus).toBe("overlap_ambiguous")
    expect(seal.getTurn(SESSION_ID, second?.turnOrdinal ?? 0)?.correlationStatus).toBe("overlap_ambiguous")
    seal.handleSessionIdle(SESSION_ID)
    seal.handleSessionIdle(SESSION_ID)

    const records = observations(directory)
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.correlationStatus === "overlap_ambiguous")).toBe(true)
    expect(new Set(records.map((record) => record.turnOrdinal)).size).toBe(2)
    expect(readFileSync(sink.filePath, "utf8").split("\n").filter((line) => line.includes('"kind":"observation"'))).toHaveLength(2)
    expect("update" in sink || "rewrite" in sink || "delete" in sink).toBe(false)
  })

  test("#given Jev predicted none and observed nothing #when timeout seals the empty set #then inflation is censored and headline-ineligible", async () => {
    const { directory, scheduler, seal } = createHarness()
    seal.handleMessage(turnInput("no delegation", { dispatch: async () => NONE_RESULT }))
    await settle()

    scheduler.fire(TURN_SEAL_TIMEOUT_MS)

    const record = observations(directory)[0]
    expect(record?.answers?.category.choice).toBe("none")
    expect(record?.observed).toEqual([])
    expect(record?.correlationStatus).toBe("censored")
    expect(record?.correlationStatus === "reliable").toBe(false)
  })

  test("#given a sealed pending record #when prediction becomes terminal #then finalization waits for both preconditions", async () => {
    let resolvePrediction: ((result: IntentRoutingDecisionResult) => void) | undefined
    const pending = new Promise<IntentRoutingDecisionResult>((resolve) => { resolvePrediction = resolve })
    const { directory, seal } = createHarness()
    seal.handleMessage(turnInput("pending", { dispatch: () => pending }))

    seal.handleSessionIdle(SESSION_ID)
    expect(observations(directory)).toHaveLength(0)
    resolvePrediction?.(NONE_RESULT)
    await settle()

    expect(observations(directory)).toHaveLength(1)
  })

  test("#given finalized records #when the corpus is inspected #then seal and classification fields are always set", () => {
    const { directory, scheduler, seal } = createHarness()
    seal.handleMessage(turnInput("complete"))
    scheduler.fire(TURN_SEAL_TIMEOUT_MS)

    expect(observations(directory).every((record) => record.sealedBy !== null && record.correlationStatus !== null)).toBe(true)
  })

  test("#given seal timeout not above prediction timeout #when config parses #then the todo-2 refine rejects it", () => {
    const equal = JevConfigSchema.safeParse({ wires: { intent_routing: { timeout_ms: 5000, turn_seal_timeout_ms: 5000 } } })
    const below = JevConfigSchema.safeParse({ wires: { intent_routing: { timeout_ms: 5000, turn_seal_timeout_ms: 4000 } } })

    expect(equal.success).toBe(false)
    expect(below.success).toBe(false)
  })
})
