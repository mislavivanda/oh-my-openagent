import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const CHILD_PATH = join(import.meta.dir, "intent-routing-inert.child.test.ts")
const CHILD_TIMEOUT_MS = 2_000
const HANDLER_BOUND_MS = 50
const HEAP_GROWTH_BOUND_BYTES = 16 * 1024 * 1024

const StressMetricsSchema = z.object({
  turns: z.literal(50),
  disabledWallMs: z.number().nonnegative(),
  enabledWallMs: z.number().nonnegative(),
  addedWallMs: z.number().nonnegative(),
  maxInFlight: z.number().int().nonnegative(),
  dispatchesDropped: z.number().int().nonnegative(),
  fetchStarts: z.number().int().nonnegative(),
  heapGrowthBytes: z.number().int().nonnegative(),
  observationCount: z.number().int().nonnegative(),
  sinkPath: z.string(),
  sinkExists: z.boolean(),
  home: z.string(),
})

const ExitReceiptSchema = z.object({
  wireEnabled: z.literal(true),
  home: z.string(),
  sinkPath: z.string(),
})

type ChildRun = {
  readonly exitCode: number
  readonly elapsedMs: number
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

async function runChild(mode: "stress" | "exit", home: string): Promise<ChildRun> {
  const startedAt = performance.now()
  const child = Bun.spawn({
    cmd: [process.execPath, "run", CHILD_PATH],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      TASK15_CHILD_MODE: mode,
      TASK15_CHILD_RECEIPT: join(home, "child-receipt.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, CHILD_TIMEOUT_MS)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)
  return {
    exitCode,
    elapsedMs: performance.now() - startedAt,
    timedOut,
    stdout,
    stderr,
  }
}

describe("chat.message Jev intent-routing hanging backend runtime effects", () => {
  test("#given the real dispatcher and sink under a hanging backend #when 50 turns run #then latency, in-flight work, drops, and heap stay bounded", async () => {
    const home = mkdtempSync(join(tmpdir(), "task-15-stress-home-"))
    try {
      const child = await runChild("stress", home)
      const metricsLine = child.stdout.split("\n").find((line) => line.startsWith("TASK15_STRESS_JSON="))
      const metrics = StressMetricsSchema.parse(JSON.parse(metricsLine?.slice("TASK15_STRESS_JSON=".length) ?? "null"))

      expect(child.timedOut, child.stderr).toBe(false)
      expect(child.exitCode, child.stderr).toBe(0)
      expect(metrics.addedWallMs).toBeLessThan(HANDLER_BOUND_MS)
      expect(metrics.maxInFlight).toBe(4)
      expect(metrics.dispatchesDropped).toBe(46)
      expect(metrics.fetchStarts).toBe(4)
      expect(metrics.heapGrowthBytes).toBeLessThan(HEAP_GROWTH_BOUND_BYTES)
      expect(metrics.observationCount).toBe(50)
      expect(metrics.sinkExists).toBe(true)
      expect(metrics.home).toBe(home)
      expect(metrics.sinkPath.startsWith(join(home, ".omo", "jev"))).toBe(true)
      console.log(
        `TASK15_STRESS addedWallMs=${metrics.addedWallMs.toFixed(3)} enabledWallMs=${metrics.enabledWallMs.toFixed(3)} disabledWallMs=${metrics.disabledWallMs.toFixed(3)} maxInFlight=${metrics.maxInFlight} dispatchesDropped=${metrics.dispatchesDropped} fetchStarts=${metrics.fetchStarts} heapGrowthBytes=${metrics.heapGrowthBytes} observations=${metrics.observationCount} childExitCode=${child.exitCode} childElapsedMs=${child.elapsedMs.toFixed(3)} home=${home}`,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      console.log(`TASK15_STRESS_CLEANUP removed=${home}`)
    }
  }, 10_000)

  test("#given an enabled wire with a hanging real backend #when the parent does not await it #then the child exits cleanly because timers are unrefed", async () => {
    const home = mkdtempSync(join(tmpdir(), "task-15-unref-home-"))
    const receiptPath = join(home, "child-receipt.json")
    try {
      const child = await runChild("exit", home)
      const receipt = ExitReceiptSchema.parse(JSON.parse(
        existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : "null",
      ))

      expect(child.timedOut, child.stderr).toBe(false)
      expect(child.exitCode, child.stderr).toBe(0)
      expect(child.elapsedMs).toBeLessThan(CHILD_TIMEOUT_MS)
      expect(receipt.home).toBe(home)
      expect(receipt.sinkPath.startsWith(join(home, ".omo", "jev"))).toBe(true)
      console.log(
        `TASK15_UNREF childExitCode=${child.exitCode} childElapsedMs=${child.elapsedMs.toFixed(3)} timedOut=${child.timedOut} wireEnabled=${receipt.wireEnabled} home=${home}`,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      console.log(`TASK15_UNREF_CLEANUP removed=${home}`)
    }
  }, 10_000)
})
