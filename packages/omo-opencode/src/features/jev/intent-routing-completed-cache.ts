import type { CompletedPrediction, MutableTurn, TurnStoreState } from "./intent-routing-turn-types"

function sessionCache(
  state: TurnStoreState,
  sessionID: string,
): Map<string, CompletedPrediction> {
  const existing = state.completedBySession.get(sessionID)
  if (existing !== undefined) return existing
  const created = new Map<string, CompletedPrediction>()
  state.completedBySession.set(sessionID, created)
  return created
}

export function cacheCompletedPrediction(state: TurnStoreState, turn: MutableTurn): void {
  if (turn.predictionState !== "filled" || turn.resolvedModel === null) return
  const cache = sessionCache(state, turn.sessionID)
  cache.delete(turn.reuseKey)
  cache.set(turn.reuseKey, {
    sourceTurnOrdinal: turn.turnOrdinal,
    reuseKey: turn.reuseKey,
    unavailableReason: turn.unavailableReason,
    resolvedModel: turn.resolvedModel,
    latencyMs: turn.latencyMs,
    answers: turn.answers,
    invalidAnswerCount: turn.invalidAnswerCount,
    truncatedInput: turn.truncatedInput,
  })
  while (cache.size > state.maxCompletedPredictionsPerSession) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

export function findCompletedPrediction(
  state: TurnStoreState,
  sessionID: string,
  reuseKey: string,
): CompletedPrediction | undefined {
  const cache = state.completedBySession.get(sessionID)
  const prediction = cache?.get(reuseKey)
  if (cache === undefined || prediction === undefined) return undefined
  cache.delete(reuseKey)
  cache.set(reuseKey, prediction)
  return prediction
}

export function dropEvictedPrediction(state: TurnStoreState, turn: MutableTurn): void {
  const cache = state.completedBySession.get(turn.sessionID)
  const prediction = cache?.get(turn.reuseKey)
  if (cache === undefined || prediction?.sourceTurnOrdinal !== turn.turnOrdinal) return
  cache.delete(turn.reuseKey)
  if (cache.size === 0) state.completedBySession.delete(turn.sessionID)
}

export function clearCompletedPredictions(state: TurnStoreState, sessionID: string): void {
  state.completedBySession.delete(sessionID)
}

export function completedPredictionCount(state: TurnStoreState): number {
  let count = 0
  for (const cache of state.completedBySession.values()) count += cache.size
  return count
}
