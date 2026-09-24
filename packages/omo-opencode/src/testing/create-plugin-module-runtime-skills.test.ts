import { beforeEach, describe, expect, it, mock } from "bun:test"

import {
  createTestPluginModule,
  mockCreateManagers,
  mockCreatePluginInterface,
  mockCreateRuntimeSkillSourceServer,
  mockCreateTools,
  mockLoadPluginConfig,
  mockRuntimeSkillSourceStop,
  resetCreatePluginModuleTestHarness,
} from "./create-plugin-module.test-support"

describe("createPluginModule runtime skill source", () => {
  beforeEach(resetCreatePluginModuleTestHarness)

  it("#given bundled security skills are enabled #then startup exposes their source URL", async () => {
    const pluginModule = createTestPluginModule()
    mockLoadPluginConfig.mockReturnValue({})

    await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    const sourceArgs = mockCreateRuntimeSkillSourceServer.mock.calls.at(0)?.[0]
    expect(sourceArgs?.skills.map((skill) => skill.name)).toEqual([
      "security-research",
      "security-review",
    ])
    expect(mockCreateManagers.mock.calls.at(0)?.[0]).toMatchObject({
      runtimeSkillSourceUrl: "http://127.0.0.1:49152/security-research,security-review",
    })
  })

  it("#given the source server is unavailable #then startup continues without a source URL", async () => {
    const pluginModule = createTestPluginModule()
    const consoleWarn = mock(() => {})
    const originalWarn = console.warn
    console.warn = consoleWarn
    mockLoadPluginConfig.mockReturnValue({})
    mockCreateRuntimeSkillSourceServer.mockImplementationOnce(() => {
      throw new Error("Runtime skill source server requires Bun.serve")
    })

    try {
      await pluginModule.server({
        directory: "/tmp/project",
        client: {},
      } as Parameters<typeof pluginModule.server>[0])

      expect(mockCreateManagers.mock.calls.at(0)?.[0]?.runtimeSkillSourceUrl).toBeUndefined()
      expect(mockCreateTools).toHaveBeenCalledTimes(1)
      expect(mockCreatePluginInterface).toHaveBeenCalledTimes(1)
      expect(consoleWarn).toHaveBeenCalledWith(
        "[runtime-skills] bundled security skill source unavailable; continuing without config.skills.urls: Runtime skill source server requires Bun.serve",
      )
    } finally {
      console.warn = originalWarn
    }
  })

  it("#given a running source server #when the plugin disposes #then the source stops", async () => {
    const pluginModule = createTestPluginModule()
    mockLoadPluginConfig.mockReturnValue({})
    const hooks: Awaited<ReturnType<typeof pluginModule.server>> & {
      dispose?: () => Promise<void>
    } = await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    await hooks.dispose?.()

    expect(mockRuntimeSkillSourceStop).toHaveBeenCalledTimes(1)
  })

  it("#given security-research is disabled #then startup still exposes security-review", async () => {
    const pluginModule = createTestPluginModule()
    mockLoadPluginConfig.mockReturnValue({ disabled_skills: ["security-research"] })

    await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    const sourceArgs = mockCreateRuntimeSkillSourceServer.mock.calls.at(0)?.[0]
    expect(sourceArgs?.skills.map((skill) => skill.name)).toEqual(["security-review"])
    expect(mockCreateManagers.mock.calls.at(0)?.[0]).toMatchObject({
      runtimeSkillSourceUrl: "http://127.0.0.1:49152/security-review",
    })
  })
})
