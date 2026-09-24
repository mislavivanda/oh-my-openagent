import type { IntentRoutingCounterDelta } from "./intent-routing-record"
import { validateIntentRoutingCounterDelta } from "./intent-routing-record-validation"

export function resolveIntentRoutingCounterDeltas(
  values: Iterable<unknown>,
): ReadonlyMap<string, IntentRoutingCounterDelta> {
  const resolved = new Map<string, IntentRoutingCounterDelta>()

  for (const value of values) {
    if (!validateIntentRoutingCounterDelta(value)) continue

    const current = resolved.get(value.processId)
    if (
      current === undefined ||
      value.counterEpoch > current.counterEpoch ||
      (value.counterEpoch === current.counterEpoch && value.monotonicSeq > current.monotonicSeq)
    ) {
      resolved.set(value.processId, value)
    }
  }

  return resolved
}
