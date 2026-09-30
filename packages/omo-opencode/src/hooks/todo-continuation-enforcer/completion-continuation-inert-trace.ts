export type TraceOwner = "gauntlet" | "w2"
export type InertTraceEntry = readonly [owner: TraceOwner, effect: string, payload?: unknown]

export const W2_OWNED_EFFECTS = new Set([
  "observeEvent",
  "recordPreInputSkip",
  "beginIdle",
  "finishHeuristic",
  "markContinuationActivity",
  "humanIntervention",
  "deleteSession",
  "dispose",
  "macrotask",
  "outcome_timer",
  "sink_interval",
  "backend_call",
  "log",
  "counter",
  "file",
])

export class InertTraceMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InertTraceMismatchError"
  }
}

export function splitOwnedTrace(trace: readonly InertTraceEntry[]): {
  readonly existing: readonly InertTraceEntry[]
  readonly removed: readonly InertTraceEntry[]
} {
  const existing: InertTraceEntry[] = []
  const removed: InertTraceEntry[] = []
  for (const entry of trace) {
    if (entry[0] === "gauntlet") {
      existing.push(entry)
      continue
    }
    if (!W2_OWNED_EFFECTS.has(entry[1])) {
      throw new InertTraceMismatchError(`unknown W2-owned effect: ${entry[1]}`)
    }
    removed.push(entry)
  }
  return { existing, removed }
}

export function assertExistingTrace(
  expected: readonly InertTraceEntry[],
  actual: readonly InertTraceEntry[],
): void {
  const leaked = actual.find(([owner]) => owner === "w2")
  if (leaked !== undefined) {
    throw new InertTraceMismatchError(`W2-owned effect leaked into Part A: ${leaked[1]}`)
  }
  const expectedBytes = JSON.stringify(expected)
  const actualBytes = JSON.stringify(actual)
  if (actualBytes !== expectedBytes) {
    throw new InertTraceMismatchError(`existing trace byte mismatch\nexpected=${expectedBytes}\nactual=${actualBytes}`)
  }
}

export function perturbPayload(
  trace: readonly InertTraceEntry[],
  effect: string,
  suffix: string,
): readonly InertTraceEntry[] {
  let changed = false
  return trace.map((entry): InertTraceEntry => {
    if (changed || entry[1] !== effect) return entry
    changed = true
    return [entry[0], entry[1], `${String(entry[2])}${suffix}`]
  })
}

export function perturbOrder(
  trace: readonly InertTraceEntry[],
  firstEffect: string,
  secondEffect: string,
): readonly InertTraceEntry[] {
  const copy = [...trace]
  const first = copy.findIndex((entry) => entry[1] === firstEffect)
  const second = copy.findIndex((entry) => entry[1] === secondEffect)
  if (first < 0 || second < 0) return copy
  const firstEntry = copy[first]
  const secondEntry = copy[second]
  if (firstEntry === undefined || secondEntry === undefined) return copy
  copy[first] = secondEntry
  copy[second] = firstEntry
  return copy
}
