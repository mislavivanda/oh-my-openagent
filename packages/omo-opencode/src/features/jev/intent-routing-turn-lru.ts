type IntentRoutingTurnLruCandidate = {
  readonly access: number
  readonly awaitingFinalization: boolean
}

export function selectOldestIntentRoutingTurn<T extends IntentRoutingTurnLruCandidate>(
  turns: Iterable<T>,
): T | undefined {
  let oldest: T | undefined
  for (const turn of turns) {
    if (turn.awaitingFinalization) continue
    if (!oldest || turn.access < oldest.access) oldest = turn
  }
  if (oldest) return oldest
  for (const turn of turns) {
    if (!oldest || turn.access < oldest.access) oldest = turn
  }
  return oldest
}

export function selectOldestIntentRoutingSessionID<T extends { readonly access: number }>(
  sessions: ReadonlyMap<string, T>,
): string | undefined {
  let oldestID: string | undefined
  let oldestAccess = Number.POSITIVE_INFINITY
  for (const [sessionID, session] of sessions) {
    if (session.access < oldestAccess) {
      oldestID = sessionID
      oldestAccess = session.access
    }
  }
  return oldestID
}
