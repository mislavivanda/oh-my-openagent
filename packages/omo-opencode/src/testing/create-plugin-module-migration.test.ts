import { beforeEach, describe, expect, it, mock } from "bun:test"

import {
  createTestPluginModule,
  mockCreateManagers,
  mockLoadPluginConfig,
  resetCreatePluginModuleTestHarness,
} from "./create-plugin-module.test-support"

describe("createPluginModule startup migration", () => {
  beforeEach(resetCreatePluginModuleTestHarness)

  it("#given legacy configuration is consumed #then startup reloads config and emits one summary toast", async () => {
    const runOpenCodeStartupMigration = mock(() => ({
      journalResumed: false,
      migratedFrom: ["/home/alice/.config/opencode/omo.json"],
      reloadRequired: true,
      results: [],
      skippedConflictCount: 2,
    }))
    const showToast = mock(async () => ({}))
    const pluginModule = createTestPluginModule({ runOpenCodeStartupMigration })
    mockLoadPluginConfig.mockReturnValue({})

    await pluginModule.server({
      directory: "/tmp/project",
      client: { tui: { showToast } },
    } as Parameters<typeof pluginModule.server>[0])

    expect(runOpenCodeStartupMigration).toHaveBeenCalledWith({ cwd: "/tmp/project" })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      body: {
        title: "Configuration migrated",
        message: expect.stringContaining("1 legacy source"),
        variant: "success",
      },
    })
    expect(mockLoadPluginConfig).toHaveBeenCalledTimes(1)
  })

  it("#given serverPlugin initializes twice #then migration predicates run only once", async () => {
    const runOpenCodeStartupMigration = mock(() => ({
      journalResumed: false,
      migratedFrom: [],
      reloadRequired: false,
      results: [],
      skippedConflictCount: 0,
    }))
    const pluginModule = createTestPluginModule({ runOpenCodeStartupMigration })
    const input = { directory: "/tmp/project", client: {} } as Parameters<typeof pluginModule.server>[0]

    await pluginModule.server(input)
    await pluginModule.server(input)

    expect(runOpenCodeStartupMigration).toHaveBeenCalledTimes(1)
  })

  it("#given startup migration fails #then defaults survive and one loud error toast is emitted", async () => {
    const runOpenCodeStartupMigration = mock(() => ({
      error: "Migration validation failed for ~/.omo/omo.jsonc",
      journalResumed: false,
      migratedFrom: [],
      reloadRequired: false,
      results: [],
      skippedConflictCount: 0,
    }))
    const loadConfigChain = mock(() => ({
      config: {},
      messages: ["invalid config"],
      path: null,
      valid: false,
    }))
    const showToast = mock(async () => ({}))
    const pluginModule = createTestPluginModule({ loadConfigChain, runOpenCodeStartupMigration })

    const hooks = await pluginModule.server({
      directory: "/tmp/project",
      client: { tui: { showToast } },
    } as Parameters<typeof pluginModule.server>[0])

    expect(hooks).toBeDefined()
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      body: { title: "Configuration migration failed", variant: "error" },
    })
    expect(mockCreateManagers.mock.calls.at(-1)?.[0]?.pluginConfig).toEqual({})
  })
})
