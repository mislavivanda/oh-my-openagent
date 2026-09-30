import { beforeEach, describe, expect, it, mock } from "bun:test"
import { createChatMessageHandler } from "../plugin/chat-message"
import { createPluginModule } from "./create-plugin-module"
import { intentRoutingPluginDeps } from "./jev-intent-routing-test-fixture"

type RoutingReceiver = {
  readonly name: string
}

function createRoutingProbe() {
  const receivers: RoutingReceiver[] = []
  let disposeCalls = 0
  const routing = {
    name: "shared-routing",
    enabled: true,
    inFlight: 0,
    dispatchesDropped: 0,
    observe(this: RoutingReceiver): void {
      receivers.push(this)
    },
    capture(this: RoutingReceiver): boolean {
      receivers.push(this)
      return true
    },
    sealSessionIdle(this: RoutingReceiver): boolean {
      receivers.push(this)
      return true
    },
    deleteSession(): void {},
    async dispose(this: RoutingReceiver): Promise<void> {
      receivers.push(this)
      disposeCalls += 1
    },
  }
  return { routing, receivers, disposeCalls: () => disposeCalls }
}

describe("Jev intent-routing plugin wiring", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG_DIR
  })

  it("#given one plugin init #when all four consumers run #then one shared routing identity reaches each consumer", async () => {
    const probe = createRoutingProbe()
    const createRouting = mock(() => probe.routing)
    const pluginModule = createPluginModule(intentRoutingPluginDeps({
      createJevIntentRouting: createRouting,
    }))

    const hooks = await pluginModule.server({
      directory: "/tmp/jev-wiring",
      client: { tui: { showToast: async () => ({}) } },
    } as Parameters<typeof pluginModule.server>[0])
    await hooks["chat.message"]?.(
      { sessionID: "main", agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: "implement routing" }] },
    )
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "main", callID: "call-1" },
      { args: { category: "quick" } },
    )
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "main" } } })
    await hooks.dispose?.()

    expect(createRouting).toHaveBeenCalledTimes(1)
    expect(probe.receivers).toEqual([
      probe.routing,
      probe.routing,
      probe.routing,
      probe.routing,
    ])
    expect(probe.disposeCalls()).toBe(1)
  })

  it("#given a dispatcher delayed for three seconds #when chat.message runs #then the handler does not await it", async () => {
    const timerHandles: ReturnType<typeof setTimeout>[] = []
    const dispatcher = mock(() => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref()
      timerHandles.push(timer)
    }))
    const routing = {
      enabled: true,
      inFlight: 0,
      dispatchesDropped: 0,
      observe(): void {
        void dispatcher()
      },
    }
    const handler = createChatMessageHandler({
      ctx: { directory: "/tmp/jev-wiring", client: { tui: { showToast: async () => ({}) } } },
      pluginConfig: {},
      firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
      hooks: {},
      intentRouting: routing,
    })

    const startedAt = performance.now()
    await handler(
      { sessionID: "main", agent: "sisyphus" },
      { message: {}, parts: [{ type: "text", text: "route this" }] },
    )
    const elapsedMs = performance.now() - startedAt
    for (const timer of timerHandles) clearTimeout(timer)

    expect(dispatcher).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(50)
  })
})
