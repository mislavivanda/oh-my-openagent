import { mock } from "bun:test"

import { initI18n } from "../shared/i18n"
import { createPluginModule } from "./create-plugin-module"

export const sourcePlugin = new URL("../index.ts", import.meta.url).href

const mockInitConfigContext = mock(() => {})
const mockDetectExternalSkillPlugin = mock(() => ({ detected: false, pluginName: null, allPlugins: [] }))
const mockGetSkillPluginConflictWarning = mock(() => "")
export const mockDetectDuplicateOmoPlugin = mock(() => ({
  detected: false,
  pluginName: null,
  duplicatePlugins: [],
  allPlugins: [],
}))
export const mockGetDuplicateOmoPluginWarning = mock(() => "")
export const mockInjectServerAuthIntoClient = mock(() => {})
const mockLogLegacyPluginStartupWarning = mock(() => {})
const mockMigrateLegacyWorkspaceDirectory = mock(() => ({ migrated: false, skipped: [] }))
export const mockRunOpenCodeStartupMigration = mock(() => ({
  journalResumed: false,
  migratedFrom: [],
  reloadRequired: false,
  results: [],
  skippedConflictCount: 0,
}))
export const mockLoadPluginConfig = mock((_directory?: string, _context?: unknown) => ({}))
export const mockLoadConfigChain = mock((directory: string) => ({
  config: mockLoadPluginConfig(directory, {}),
  messages: [],
  path: null,
  valid: true,
}))
const mockIsTmuxIntegrationEnabled = mock(
  (pluginConfig: { tmux?: { enabled?: boolean } | undefined }) => pluginConfig.tmux?.enabled ?? false,
)
const mockCreateRuntimeTmuxConfig = mock(() => ({
  enabled: false,
  layout: "tiled" as const,
  main_pane_size: 60,
  main_pane_min_width: 80,
  agent_pane_min_width: 40,
  isolation: "inline" as const,
}))
export const mockCreateManagers = mock(() => ({
  backgroundManager: { shutdown: async () => {} },
  skillMcpManager: { disconnectAll: async () => {} },
  configHandler: async () => {},
}))
export const mockRuntimeSkillSourceStop = mock(() => {})
export const mockCreateRuntimeSkillSourceServer = mock(
  (options: { readonly skills: readonly { readonly name: string }[] }) => ({
    url: `http://127.0.0.1:49152/${options.skills.map((skill) => skill.name).join(",")}`,
    stop: mockRuntimeSkillSourceStop,
  }),
)
export const mockCreateTools = mock(async () => ({
  mergedSkills: [],
  availableSkills: [],
  filteredTools: {},
}))
export const mockCreateHooks = mock(() => ({
  disposeHooks: () => {},
  compactionContextInjector: undefined,
  compactionTodoPreserver: undefined,
  claudeCodeHooks: undefined,
}))
export const mockCreatePluginInterface = mock(() => ({}))
export const mockIntentRoutingDispose = mock(async () => {})
export const mockIntentRouting = {
  enabled: false,
  observe: () => ({ predictionStatus: "not_dispatched" as const, notDispatchedReason: "disabled" as const }),
  capture: () => {},
  onSessionIdle: () => false,
  onSessionDeleted: () => {},
  dispose: mockIntentRoutingDispose,
  getStats: () => ({ inFlight: 0, dispatchesDropped: 0 }),
}
export const mockCreateJevIntentRouting = mock(() => mockIntentRouting)
const mockInitializeOpenClaw = mock(async () => {})
const mockStartTmuxCheck = mock(() => {})
const mockInstallAgentSortShim = mock(() => {})
const mockSetAgentSortOrder = mock(() => {})
export const mockLog = mock(() => {})
const mockCreateModelCacheState = mock(() => ({}))
const mockCreateFirstMessageVariantGate = mock(() => ({
  shouldOverride: () => false,
  markApplied: () => {},
  markSessionCreated: () => {},
  clear: () => {},
}))

export function createTestPluginModule(
  overrides: Parameters<typeof createPluginModule>[0] = {},
): ReturnType<typeof createPluginModule> {
  const dependencies = {
    initConfigContext: mockInitConfigContext,
    detectExternalSkillPlugin: mockDetectExternalSkillPlugin,
    getSkillPluginConflictWarning: mockGetSkillPluginConflictWarning,
    detectDuplicateOmoPlugin: mockDetectDuplicateOmoPlugin,
    getDuplicateOmoPluginWarning: mockGetDuplicateOmoPluginWarning,
    injectServerAuthIntoClient: mockInjectServerAuthIntoClient,
    logLegacyPluginStartupWarning: mockLogLegacyPluginStartupWarning,
    migrateLegacyWorkspaceDirectory: mockMigrateLegacyWorkspaceDirectory,
    runOpenCodeStartupMigration: mockRunOpenCodeStartupMigration,
    loadConfigChain: mockLoadConfigChain as never,
    loadPluginConfig: mockLoadPluginConfig as never,
    isTmuxIntegrationEnabled: mockIsTmuxIntegrationEnabled as never,
    createRuntimeTmuxConfig: mockCreateRuntimeTmuxConfig as never,
    createManagers: mockCreateManagers as never,
    createRuntimeSkillSourceServer: mockCreateRuntimeSkillSourceServer as never,
    createTools: mockCreateTools as never,
    createHooks: mockCreateHooks as never,
    createPluginInterface: mockCreatePluginInterface as never,
    initializeOpenClaw: mockInitializeOpenClaw as never,
    startTmuxCheck: mockStartTmuxCheck,
    installAgentSortShim: mockInstallAgentSortShim,
    setAgentSortOrder: mockSetAgentSortOrder,
    log: mockLog,
    createModelCacheState: mockCreateModelCacheState as never,
    createFirstMessageVariantGate: mockCreateFirstMessageVariantGate as never,
    ...overrides,
  }
  Reflect.set(dependencies, "createJevIntentRouting", mockCreateJevIntentRouting)
  return createPluginModule(dependencies)
}

export function resetCreatePluginModuleTestHarness(): void {
  mockDetectDuplicateOmoPlugin.mockClear()
  mockGetDuplicateOmoPluginWarning.mockClear()
  mockInjectServerAuthIntoClient.mockClear()
  mockLoadPluginConfig.mockClear()
  mockLoadConfigChain.mockClear()
  mockRunOpenCodeStartupMigration.mockClear()
  mockCreateManagers.mockClear()
  mockRuntimeSkillSourceStop.mockClear()
  mockCreateRuntimeSkillSourceServer.mockClear()
  mockCreateTools.mockClear()
  mockCreateHooks.mockClear()
  mockCreatePluginInterface.mockClear()
  mockCreateJevIntentRouting.mockClear()
  mockIntentRoutingDispose.mockClear()
  mockRunOpenCodeStartupMigration.mockReturnValue({
    journalResumed: false,
    migratedFrom: [],
    reloadRequired: false,
    results: [],
    skippedConflictCount: 0,
  })
  mockDetectDuplicateOmoPlugin.mockReturnValue({
    detected: false,
    pluginName: null,
    duplicatePlugins: [],
    allPlugins: [],
  })
  mockGetDuplicateOmoPluginWarning.mockReturnValue("")
  initI18n({ locale: "en", fallback: "en" })
}
