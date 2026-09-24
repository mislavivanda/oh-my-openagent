import { beforeEach, describe, expect, it, mock } from "bun:test"

import {
  createTestPluginModule,
  mockCreateJevIntentRouting,
  mockCreatePluginInterface,
  mockIntentRouting,
  mockIntentRoutingDispose,
  mockLoadPluginConfig,
  mockLog,
  resetCreatePluginModuleTestHarness,
} from "./create-plugin-module.test-support"

describe("createPluginModule lifecycle", () => {
  beforeEach(resetCreatePluginModuleTestHarness)

  it("#given one initialization #then one intent-routing instance reaches interface and dispose", async () => {
    const pluginModule = createTestPluginModule()
    mockLoadPluginConfig.mockReturnValue({})
    const hooks: Awaited<ReturnType<typeof pluginModule.server>> & {
      dispose?: () => Promise<void>
    } = await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    await hooks.dispose?.()

    expect(mockCreateJevIntentRouting).toHaveBeenCalledTimes(1)
    const interfaceArgs = mockCreatePluginInterface.mock.calls.at(0)?.[0]
    expect(interfaceArgs && Reflect.get(interfaceArgs, "intentRouting")).toBe(mockIntentRouting)
    expect(mockIntentRoutingDispose).toHaveBeenCalledTimes(1)
  })

  it("#given a never-resolving process sweep #then startup completes without awaiting it", async () => {
    const startOmoProcessSweep = mock(() => new Promise<void>(() => {}))
    const pluginModule = createTestPluginModule({ startOmoProcessSweep })
    mockLoadPluginConfig.mockReturnValue({})

    const hooks = await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    expect(startOmoProcessSweep).toHaveBeenCalledTimes(1)
    expect(hooks).toBeDefined()
    expect(mockCreatePluginInterface).toHaveBeenCalled()
  })

  it("#given a rejected process sweep #then the failure is logged and cannot propagate", async () => {
    const startOmoProcessSweep = mock(() => Promise.reject(new Error("sweep boom")))
    const pluginModule = createTestPluginModule({ startOmoProcessSweep })
    mockLoadPluginConfig.mockReturnValue({})
    mockLog.mockClear()

    const hooks = await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])
    await Promise.resolve()
    await Promise.resolve()

    expect(hooks).toBeDefined()
    const sweepLogs = mockLog.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("omo process sweep failed"),
    )
    expect(sweepLogs).toHaveLength(1)
  })

  it("#given a synchronously throwing process sweep #then startup still completes", async () => {
    const startOmoProcessSweep = mock(() => {
      throw new Error("sync sweep boom")
    })
    const pluginModule = createTestPluginModule({ startOmoProcessSweep })
    mockLoadPluginConfig.mockReturnValue({})

    const hooks = await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    expect(hooks).toBeDefined()
    expect(mockCreatePluginInterface).toHaveBeenCalled()
  })
})
