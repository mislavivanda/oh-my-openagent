import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION } from "./completion-continuation-outcome-types"
import {
  MAX_INFLIGHT,
  measureAddedIdleHandlerP99,
  measureSynchronousSeamP99,
  removedUnrefFailure,
  runOneSessionStress,
} from "./completion-continuation-runtime-fixture"

const SINK_FLUSH_INTERVAL_HANDLES = 1

/**
 * Every timer the one-session stress can still hold at the end of the run, derived from the
 * bounds that produce them rather than pinned to a literal:
 *   - one repeating sink flush interval,
 *   - one retention timer per retained outcome window (`maxRecordsPerSession`),
 *   - one backend timeout per decision still in flight (`max_inflight`).
 * Today that is 1 + 64 + 8 = 73. Raise either bound and this recomputes, so the budget stays a
 * real ceiling instead of a literal that a future observer silently outgrows. Never widen it by
 * hand to create slack; change the bound the extra handles actually come from.
 */
const ACTIVE_HANDLE_BUDGET =
  SINK_FLUSH_INTERVAL_HANDLES + DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION + MAX_INFLIGHT

type ChildResult = {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly elapsedMs: number
  readonly pid: number
  readonly stdout: string
  readonly stderr: string
}

async function runUnrefChild(rootDir: string, omitUnref: boolean): Promise<ChildResult> {
  const childPath = join(import.meta.dir, "completion-continuation-unref-child.ts")
  const startedAt = performance.now()
  const child = Bun.spawn([process.execPath, "run", childPath], {
    cwd: join(import.meta.dir, "../../../.."),
    env: {
      ...process.env,
      W2_TEST_ROOT: rootDir,
      W2_TEST_OMIT_UNREF: omitUnref ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const pid = child.pid
  const deadlineMs = omitUnref ? 750 : 2_000
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    Bun.sleep(deadlineMs).then(() => ({ exitCode: -1, timedOut: true })),
  ])
  if (outcome.timedOut) {
    child.kill()
    await child.exited
  }
  return {
    ...outcome,
    elapsedMs: performance.now() - startedAt,
    pid,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }
}

describe("completion-continuation Part B runtime effects", () => {
  test("bounds handles, in-flight work, persisted drops, heap, and repeated dispose", async () => {
    const measurements = await runOneSessionStress()

    console.log(`w2_active_timer_handles_budget=${ACTIVE_HANDLE_BUDGET} derivation=${SINK_FLUSH_INTERVAL_HANDLES}_sink_interval+${DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION}_outcome_windows+${MAX_INFLIGHT}_inflight_backend_timeouts`)
    console.log(`w2_active_timer_handles<=${ACTIVE_HANDLE_BUDGET} actual=${measurements.activeHandles}`)
    console.log(`w2_unref_missing=0 actual=${measurements.unrefMissing}`)
    console.log(`in_flight_max<=${MAX_INFLIGHT} actual=${measurements.inFlightMax}`)
    console.log(`dispatches_dropped_persisted=${measurements.persistedDrops} attempted_excess=${measurements.attemptedExcess}`)
    console.log(`heap_delta_bytes=${measurements.heapDeltaBytes} threshold<${16 * 1024 * 1024}`)

    expect(measurements.activeHandles).toBeLessThanOrEqual(ACTIVE_HANDLE_BUDGET)
    expect(measurements.unrefMissing).toBe(0)
    expect(measurements.inFlightMax).toBeLessThanOrEqual(MAX_INFLIGHT)
    expect(measurements.persistedDrops).toBe(measurements.attemptedExcess)
    expect(measurements.heapDeltaBytes).toBeLessThan(16 * 1024 * 1024)
  })

  test("keeps isolated synchronous and mocked idle-handler p99 budgets", async () => {
    const synchronousP99Ms = await measureSynchronousSeamP99()
    const addedIdleP99Ms = await measureAddedIdleHandlerP99()
    const antiVacuity = await removedUnrefFailure()

    console.log(`sync_seam_p99_ms=${synchronousP99Ms.toFixed(6)} threshold<1`)
    console.log(`idle_handler_added_p99_ms=${addedIdleP99Ms.toFixed(6)} threshold<5`)
    console.log(`ANTI_VACUITY_UNREF_HANDLE=FAIL_DETECTED ${antiVacuity}`)
    console.log("ANTI_VACUITY_UNREF_HANDLE_REVERT=PASS normal audit restored")

    expect(synchronousP99Ms).toBeLessThan(1)
    expect(addedIdleP99Ms).toBeLessThan(5)
    expect(antiVacuity).toContain("unref audit failed")
  })

  test("child exits with a hanging backend because every timer is unrefed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jev-w2-child-"))
    try {
      const perturbed = await runUnrefChild(rootDir, true)
      console.log(`ANTI_VACUITY_UNREF_CHILD=FAIL_DETECTED timed_out=${perturbed.timedOut} pid=${perturbed.pid} elapsed_ms=${perturbed.elapsedMs.toFixed(2)}`)
      expect(perturbed.timedOut, perturbed.stderr).toBe(true)
      expect(perturbed.stdout).toContain("BACKEND_IN_FLIGHT")

      const reverted = await runUnrefChild(rootDir, false)
      console.log(`child_exit_ms=${reverted.elapsedMs.toFixed(2)} threshold<2000 pid=${reverted.pid} exit=${reverted.exitCode}`)
      console.log("ANTI_VACUITY_UNREF_CHILD_REVERT=PASS unref restored")
      expect(reverted.timedOut, reverted.stderr).toBe(false)
      expect(reverted.exitCode, reverted.stderr).toBe(0)
      expect(reverted.stdout).toContain("DISPOSED_TWICE")
      expect(reverted.elapsedMs).toBeLessThan(2_000)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
