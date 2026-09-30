import type { DecisionBackend, DecisionOutcome, DecisionRequest, Questions } from "@oh-my-opencode/jev-core"

import { JevConfigSchema } from "../../config/schema/jev"
import { createJevCompletionContinuation, type JevCompletionContinuationClock } from "./completion-continuation"
import { HEURISTIC_FACTS } from "./completion-continuation.test-support"

const rootDir = process.env.W2_TEST_ROOT
if (rootDir === undefined || rootDir.length === 0) throw new TypeError("W2_TEST_ROOT is required")
const omitUnref = process.env.W2_TEST_OMIT_UNREF === "1"

const clock: JevCompletionContinuationClock = {
  now: Date.now,
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs)
    return {
      cancel: () => clearTimeout(timer),
      unref: () => { if (!omitUnref) timer.unref() },
    }
  },
}

let signalBackendStarted: (() => void) | undefined
const backendStarted = new Promise<void>((resolve) => { signalBackendStarted = resolve })
const backend: DecisionBackend = {
  kind: "mock",
  decide<Q extends Questions>(_request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
    signalBackendStarted?.()
    return new Promise(() => undefined)
  },
}
const config = JevConfigSchema.parse({
  enabled: true,
  backend: "mock",
  model: "jev-w2-unref-child",
  wires: { completion_continuation: {
    enabled: true,
    timeout_ms: 5_000,
    outcome_window_ms: 6_000,
    max_inflight: 8,
  } },
})
const adapter = createJevCompletionContinuation({
  jevConfig: config,
  rootDir,
  clock,
  backend,
  logger: () => {},
})

adapter.beginIdle({
  sessionID: "child-session",
  directory: rootDir,
  todos: [{ id: "todo", status: "in_progress", content: "leave backend hanging" }],
  transcript: [{ role: "assistant", content: "working", synthetic: false }],
  isContinuationCandidate: true,
})
adapter.finishHeuristic("child-session", HEURISTIC_FACTS)
await backendStarted
process.stdout.write(`BACKEND_IN_FLIGHT omit_unref=${omitUnref}\n`)
await adapter.dispose()
await adapter.dispose()
process.stdout.write("DISPOSED_TWICE\n")
