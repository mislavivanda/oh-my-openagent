import { describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { PluginModuleDeps } from "./create-plugin-module"
import { createPluginModule } from "./create-plugin-module"

describe("createPluginModule intent-routing wiring", () => {
  test("#given one constructed routing instance #when all four consumers run #then each receives the same object identity", async () => {
    // given
    const consumers: string[] = []
    const intentRouting = {
      enabled: false,
      inFlight: 0,
      dispatchesDropped: 0,
      dispatch(this: object): void {
        expect(this).toBe(intentRouting)
        consumers.push("chat.message")
      },
      capture(this: object): boolean {
        expect(this).toBe(intentRouting)
        consumers.push("tool.execute.before")
        return false
      },
      handleSessionIdle(this: object): void {
        expect(this).toBe(intentRouting)
        consumers.push("event")
      },
      handleSessionDeleted(): void {},
      async dispose(this: object): Promise<void> {
        expect(this).toBe(intentRouting)
        consumers.push("dispose")
      },
    }
    const createJevIntentRouting = mock(() => intentRouting)
    const pluginModule = createPluginModule(unsafeTestValue<Partial<PluginModuleDeps>>({
      createJevIntentRouting,
      initConfigContext: () => {},
      installAgentSortShim: () => {},
      setAgentSortOrder: () => {},
      log: () => {},
      logLegacyPluginStartupWarning: () => {},
      migrateLegacyWorkspaceDirectory: () => ({ migrated: false, skipped: [] }),
      runOpenCodeStartupMigration: () => ({
        journalResumed: false,
        migratedFrom: [],
        reloadRequired: false,
        results: [],
        skippedConflictCount: 0,
      }),
      startOmoProcessSweep: async () => {},
      detectDuplicateOmoPlugin: () => ({
        detected: false,
        pluginName: null,
        duplicatePlugins: [],
        allPlugins: [],
      }),
      getDuplicateOmoPluginWarning: () => "",
      detectExternalSkillPlugin: () => ({ detected: false, pluginName: null, allPlugins: [] }),
      getSkillPluginConflictWarning: () => "",
      injectServerAuthIntoClient: () => {},
      initLiveServerRoute: () => {},
      setLiveParentWakeRoutingDisabled: () => {},
      warmLiveServerProbe: () => {},
      loadConfigChain: () => unsafeTestValue({
        config: { tui: { sidebar: { enabled: false } } },
        messages: [],
        path: null,
        valid: true,
      }),
      recordPluginTelemetry: () => {},
      initI18n: () => {},
      initializeOpenClaw: async () => {},
      isTmuxIntegrationEnabled: () => false,
      startTmuxCheck: () => {},
      createFirstMessageVariantGate: () => ({
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      }),
      createRuntimeTmuxConfig: () => unsafeTestValue({ enabled: false }),
      createModelCacheState: () => unsafeTestValue({}),
      createManagers: () => unsafeTestValue({
        backgroundManager: {
          shutdown: async () => {},
          hasActiveChildTasks: () => false,
          hasPendingParentWake: () => false,
        },
        skillMcpManager: { disconnectAll: async () => {} },
        configHandler: async () => {},
      }),
      createTools: async () => unsafeTestValue({
        mergedSkills: [],
        availableSkills: [],
        filteredTools: {},
      }),
      createRuntimeSkillSourceServer: async () => ({
        url: "http://127.0.0.1:49152",
        stop: () => {},
      }),
      createHooks: () => unsafeTestValue({ disposeHooks: () => {} }),
    }))
    const hooks = await pluginModule.server(unsafeTestValue({
      directory: "/tmp/jev-intent-routing-wiring",
      client: { tui: { showToast: async () => {} } },
    }))

    // when
    await hooks["chat.message"]?.(
      unsafeTestValue({ sessionID: "ses-wiring", agent: "sisyphus" }),
      unsafeTestValue({ message: {}, parts: [{ type: "text", text: "route this" }] }),
    )
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "ses-wiring", callID: "call-1" },
      { args: { category: "quick" } },
    )
    await hooks.event?.(unsafeTestValue({
      event: { type: "session.idle", properties: { sessionID: "ses-wiring" } },
    }))
    await unsafeTestValue<(() => Promise<void>) | undefined>(hooks.dispose)?.()

    // then
    expect(createJevIntentRouting).toHaveBeenCalledTimes(1)
    expect(consumers).toEqual([
      "chat.message",
      "tool.execute.before",
      "event",
      "dispose",
    ])
  })
})
