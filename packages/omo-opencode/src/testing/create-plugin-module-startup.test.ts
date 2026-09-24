import { beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PLUGIN_NAME } from "../shared"
import { getLocale, t } from "../shared/i18n"
import {
  createTestPluginModule,
  mockCreateHooks,
  mockCreateManagers,
  mockCreatePluginInterface,
  mockCreateTools,
  mockDetectDuplicateOmoPlugin,
  mockGetDuplicateOmoPluginWarning,
  mockInjectServerAuthIntoClient,
  mockLoadPluginConfig,
  resetCreatePluginModuleTestHarness,
  sourcePlugin,
} from "./create-plugin-module.test-support"

describe("createPluginModule startup", () => {
  beforeEach(resetCreatePluginModuleTestHarness)

  it("#given plugin config sets i18n.locale to zh #then startup applies the configured locale", async () => {
    const pluginModule = createTestPluginModule()
    mockLoadPluginConfig.mockReturnValue({ i18n: { locale: "zh" } })

    await pluginModule.server({
      directory: "/tmp/project",
      client: {},
    } as Parameters<typeof pluginModule.server>[0])

    expect(getLocale()).toBe("zh")
    expect(t("toast.task_completed")).toBe("任务完成")
  })

  describe("#given OpenCode server config is present", () => {
    it("#then startup self-heals the matching TUI plugin entry", async () => {
      const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
      const configDir = mkdtempSync(join(tmpdir(), "omo-server-tui-entry-"))
      process.env.OPENCODE_CONFIG_DIR = configDir
      writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [PLUGIN_NAME] }), "utf-8")

      try {
        const pluginModule = createTestPluginModule()
        mockLoadPluginConfig.mockReturnValue({})

        await pluginModule.server({
          directory: "/tmp/project",
          client: {},
        } as Parameters<typeof pluginModule.server>[0])

        expect(readFileSync(join(configDir, "tui.json"), "utf-8")).toContain(`"${PLUGIN_NAME}"`)
      } finally {
        rmSync(configDir, { recursive: true, force: true })
        if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
      }
    })

    it("#given sidebar is disabled #then startup does not write a TUI plugin entry", async () => {
      const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
      const configDir = mkdtempSync(join(tmpdir(), "omo-server-tui-disabled-"))
      process.env.OPENCODE_CONFIG_DIR = configDir
      writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [PLUGIN_NAME] }), "utf-8")

      try {
        const pluginModule = createTestPluginModule()
        mockLoadPluginConfig.mockReturnValue({ tui: { sidebar: { enabled: false } } })

        await pluginModule.server({
          directory: "/tmp/project",
          client: {},
        } as Parameters<typeof pluginModule.server>[0])

        expect(() => readFileSync(join(configDir, "tui.json"), "utf-8")).toThrow()
      } finally {
        rmSync(configDir, { recursive: true, force: true })
        if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
      }
    })
  })

  it("#given duplicate OMO plugin entries #then startup warns and returns no prompt-producing hooks", async () => {
    const pluginModule = createTestPluginModule()
    const duplicatePlugins = [sourcePlugin, "oh-my-openagent@latest"]
    mockDetectDuplicateOmoPlugin.mockReturnValue({
      detected: true,
      pluginName: "oh-my-openagent",
      duplicatePlugins,
      allPlugins: duplicatePlugins,
    })
    mockGetDuplicateOmoPluginWarning.mockReturnValue("duplicate OMO startup disabled")
    const consoleWarn = mock(() => {})
    const originalWarn = console.warn
    console.warn = consoleWarn

    try {
      const hooks = await pluginModule.server({
        directory: "/tmp/project",
        client: {},
      } as Parameters<typeof pluginModule.server>[0])

      expect(hooks).toEqual({})
      expect(consoleWarn).toHaveBeenCalledWith("duplicate OMO startup disabled")
      expect(mockInjectServerAuthIntoClient).not.toHaveBeenCalled()
      expect(mockCreateManagers).not.toHaveBeenCalled()
      expect(mockCreateTools).not.toHaveBeenCalled()
      expect(mockCreateHooks).not.toHaveBeenCalled()
      expect(mockCreatePluginInterface).not.toHaveBeenCalled()
    } finally {
      console.warn = originalWarn
    }
  })
})
