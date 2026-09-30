import { isIntentRoutingContinuationCandidate } from "@oh-my-opencode/jev-core"
import { completePendingGroup } from "./intent-routing-turn-prediction"
import { clearCompletedPredictions, dropEvictedPrediction } from "./intent-routing-completed-cache"
import { EMPTY_INTENT_ROUTING_ANSWERS } from "./intent-routing-turn-record"
import {
  applyTimeout,
  emitCounterDelta,
  removeTurn,
  settleTurn,
  tryFinalize,
} from "./intent-routing-turn-runtime"
import {
  INTENT_ROUTING_PROMPT_HEAD_CHARS,
  type IntentRoutingStartTurnInput,
  type MutableTurn,
  type SessionState,
  type TurnStoreState,
} from "./intent-routing-turn-types"

function evictTurn(state: TurnStoreState, turn: MutableTurn): void {
  turn.terminalState = "evicted"
  turn.lifecycleState = "evicted"
  dropEvictedPrediction(state, turn)
  removeTurn(state, turn)
  settleTurn(turn)
  state.counters.recordsEvicted += 1
  emitCounterDelta(state)
}

function oldestTurn(
  turns: Iterable<MutableTurn>,
  includeDeferred: boolean,
): MutableTurn | undefined {
  let oldest: MutableTurn | undefined
  for (const turn of turns) {
    if (!includeDeferred && turn.deferredFinalization) continue
    if (oldest === undefined || turn.lastAccess < oldest.lastAccess) oldest = turn
  }
  return oldest
}

function forceFinalizeDeferred(state: TurnStoreState, turn: MutableTurn): void {
  if (turn.predictionState === "pending") {
    const group = turn.pendingGroup
    if (group !== undefined) completePendingGroup(state, group, undefined)
    else applyTimeout(state, turn, 0)
  }
  tryFinalize(state, turn, true)
}

function ensureTurnCapacity(state: TurnStoreState, session: SessionState): void {
  while (session.turns.size >= state.maxTurnsPerSession) {
    const victim = oldestTurn(session.turns.values(), false)
    if (victim !== undefined) {
      evictTurn(state, victim)
      continue
    }
    const deferred = oldestTurn(session.turns.values(), true)
    if (deferred === undefined) return
    forceFinalizeDeferred(state, deferred)
  }
}

function evictSession(state: TurnStoreState, session: SessionState): void {
  const deferred = [...session.turns.values()].find((turn) => turn.deferredFinalization)
  if (deferred !== undefined) forceFinalizeDeferred(state, deferred)
  for (const turn of [...session.turns.values()]) evictTurn(state, turn)
  state.sessions.delete(session.sessionID)
  clearCompletedPredictions(state, session.sessionID)
}

function ensureSessionCapacity(state: TurnStoreState): void {
  if (state.sessions.size < state.maxTrackedSessions) return
  let victim: SessionState | undefined
  for (const session of state.sessions.values()) {
    const hasDeferred = [...session.turns.values()].some((turn) => turn.deferredFinalization)
    if (hasDeferred) continue
    if (victim === undefined || session.lastAccess < victim.lastAccess) victim = session
  }
  if (victim === undefined) {
    for (const session of state.sessions.values()) {
      if (victim === undefined || session.lastAccess < victim.lastAccess) victim = session
    }
  }
  if (victim !== undefined) evictSession(state, victim)
}

function getOrCreateSession(state: TurnStoreState, sessionID: string): SessionState {
  const existing = state.sessions.get(sessionID)
  if (existing !== undefined) return existing
  ensureSessionCapacity(state)
  state.clocks.access += 1
  const created: SessionState = {
    sessionID,
    turns: new Map(),
    nextOrdinal: state.clocks.ordinalHighWater + 1,
    lastAccess: state.clocks.access,
  }
  state.sessions.set(sessionID, created)
  return created
}

export function createMutableTurn(args: {
  readonly state: TurnStoreState
  readonly input: IntentRoutingStartTurnInput
  readonly sessionID: string
  readonly normalizedPrompt: string
  readonly promptHash: string
  readonly dedupKey: string
}): MutableTurn {
  const { state, input, sessionID, normalizedPrompt, promptHash, dedupKey } = args
  const session = getOrCreateSession(state, sessionID)
  ensureTurnCapacity(state, session)
  const turnOrdinal = session.nextOrdinal
  session.nextOrdinal += 1
  state.clocks.ordinalHighWater = Math.max(state.clocks.ordinalHighWater, turnOrdinal)
  let settle: (() => void) | undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  state.clocks.access += 1
  const turn: MutableTurn = {
    sessionID,
    turnOrdinal,
    dedupKey,
    reuseKey: dedupKey,
    promptHash,
    normalizedPrompt,
    questionVersion: input.questionVersion,
    confidenceThreshold: input.confidenceThreshold,
    promptHeadChars: normalizedPrompt.slice(0, INTENT_ROUTING_PROMPT_HEAD_CHARS),
    promptChars: normalizedPrompt.length,
    isContinuationCandidate: isIntentRoutingContinuationCandidate(normalizedPrompt),
    observed: [],
    settled,
    settle,
    pendingGroup: undefined,
    predictionReused: false,
    predictionState: "pending",
    lifecycleState: "created",
    terminalState: "live",
    notDispatchedReason: null,
    unavailableReason: null,
    resolvedModel: null,
    latencyMs: 0,
    answers: EMPTY_INTENT_ROUTING_ANSWERS,
    invalidAnswerCount: 0,
    truncatedInput: false,
    sealedBy: null,
    correlationStatus: null,
    deferredFinalization: false,
    finalized: false,
    lastAccess: state.clocks.access,
  }
  session.lastAccess = state.clocks.access
  session.turns.set(turn.turnOrdinal, turn)
  state.counters.recordsCreated += 1
  return turn
}
