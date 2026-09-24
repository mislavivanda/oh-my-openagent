import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { JevConfigSchema } from "../config/schema/jev"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import {
  createIntentRoutingSealCoordinator,
  createIntentRoutingSink,
  createJevIntentRouting,
} from "../features/jev"
import { createChatMessageHandler } from "./chat-message"

const temporaryHomes: string[] = []

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "jev-task-15-"))
  temporaryHomes.push(home)
  return home
}

beforeEach(() => {
  _resetForTesting()
  setMainSession("main")
})
afterEach(async () => {
  _resetForTesting()
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Jev intent-routing hanging backend runtime effects", () => {
  test("#given the real dispatcher and sink #when 50 turns hit a hanging backend #then runtime effects stay bounded", async () => {
    const home = await temporaryHome()
    const sinkRoot = join(home, ".omo", "jev")
    const maxInflight = 2
    const turns = 50
    let activeFetches = 0
    let observedInflightCeiling = 0
    const jevConfig = JevConfigSchema.parse({
      enabled: true,
      backend: "real",
      model: "jev-inert-stress",
      wires: {
        intent_routing: {
          enabled: true,
          timeout_ms: 100,
          turn_seal_timeout_ms: 1000,
          max_inflight: maxInflight,
        },
      },
    })
    const coordinator = createIntentRoutingSealCoordinator({
      turnSealTimeoutMs: jevConfig.wires.intent_routing.turn_seal_timeout_ms,
      createSink: (getCounters) => createIntentRoutingSink({
        rootDir: sinkRoot,
        counterFlushIntervalMs: 60_000,
        getCounters,
      }),
    })
    const routing = createJevIntentRouting({
      jevConfig,
      sealCoordinator: coordinator,
      env: {
        TYPESAFE_API_KEY: "test-key",
        OMO_JEV_BASE_URL: "http://127.0.0.1:9",
      },
      fetch: async () => {
        activeFetches += 1
        observedInflightCeiling = Math.max(observedInflightCeiling, activeFetches)
        return new Promise<Response>(() => {})
      },
      logger: () => {},
    })
    const handler = createChatMessageHandler({
      ctx: { directory: home, client: { tui: { showToast: async () => ({}) } } },
      pluginConfig: {},
      firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
      hooks: {},
      intentRouting: routing,
    })
    Bun.gc(true)
    const heapBefore = process.memoryUsage().heapUsed
    const handlerDurations: number[] = []

    for (let turn = 0; turn < turns; turn += 1) {
      const startedAt = performance.now()
      await handler(
        { sessionID: "main", agent: "sisyphus" },
        { message: {}, parts: [{ type: "text", text: `stress turn ${turn}` }] },
      )
      handlerDurations.push(performance.now() - startedAt)
    }
    await Bun.sleep(25)
    Bun.gc(true)
    const heapGrowthBytes = process.memoryUsage().heapUsed - heapBefore
    const maxHandlerMs = Math.max(...handlerDurations)
    console.log([
      `TASK15_MAX_HANDLER_US=${(maxHandlerMs * 1000).toFixed(2)}`,
      `TASK15_INFLIGHT_CEILING=${observedInflightCeiling}`,
      `TASK15_DROPPED=${routing.dispatchesDropped}`,
      `TASK15_HEAP_GROWTH_BYTES=${heapGrowthBytes}`,
    ].join("\n"))

    expect(maxHandlerMs).toBeLessThan(25)
    expect(routing.inFlight).toBe(maxInflight)
    expect(observedInflightCeiling).toBe(maxInflight)
    expect(routing.dispatchesDropped).toBe(turns - maxInflight)
    expect(heapGrowthBytes).toBeLessThan(8 * 1024 * 1024)
    await routing.dispose()
  })

  test("#given the plugin wire and hanging real backend #when the child finishes setup #then unref timers permit clean exit", async () => {
    const home = await temporaryHome()
    const xdg = join(home, "xdg")
    await mkdir(xdg, { recursive: true })
    const childPath = join(import.meta.dir, "intent-routing-unref-child.ts")
    const startedAt = performance.now()
    const child = Bun.spawn([process.execPath, "run", childPath], {
      cwd: join(import.meta.dir, "../../../.."),
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(xdg, "data"),
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_STATE_HOME: join(xdg, "state"),
        XDG_CACHE_HOME: join(xdg, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
      Bun.sleep(1500).then(() => ({ exitCode: -1, timedOut: true })),
    ])
    if (outcome.timedOut) {
      child.kill()
      await child.exited
    }
    const elapsedMs = performance.now() - startedAt
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    console.log(`TASK15_CHILD_EXIT=${outcome.exitCode} ELAPSED_MS=${elapsedMs.toFixed(2)}`)

    expect(outcome.timedOut, stderr).toBe(false)
    expect(outcome.exitCode, stderr).toBe(0)
    expect(stdout).toContain("BACKEND_IN_FLIGHT")
    expect(elapsedMs).toBeLessThan(1500)
  })
})
