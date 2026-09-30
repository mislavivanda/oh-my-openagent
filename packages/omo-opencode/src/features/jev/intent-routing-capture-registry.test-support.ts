import { OhMyOpenCodeConfigSchema } from "../../config"
import { createModelFallbackControllerAccessor } from "../../hooks/model-fallback"
import { createToolRegistry } from "../../plugin/tool-registry"
import { BackgroundManager } from "../background-agent"
import { MonitorManager } from "../monitor"
import { SkillMcpManager } from "../skill-mcp-manager"
import { TmuxSessionManager } from "../tmux-subagent"

export function registeredRoutingFieldToolNames(): readonly string[] {
  const pluginConfig = OhMyOpenCodeConfigSchema.parse({
    experimental: { task_system: true },
    goal: { enabled: true },
    hashline_edit: true,
    monitor: { enabled: true },
    team_mode: { enabled: true },
  })
  const ctx = {
    directory: "/tmp/jev-capture-registry",
    client: {},
  } as Parameters<typeof createToolRegistry>[0]["ctx"]
  const managers = {
    backgroundManager: Object.create(BackgroundManager.prototype),
    tmuxSessionManager: Object.create(TmuxSessionManager.prototype),
    skillMcpManager: Object.create(SkillMcpManager.prototype),
    modelFallbackControllerAccessor: createModelFallbackControllerAccessor(),
    monitorManager: Object.create(MonitorManager.prototype),
  }
  const skillContext = {
    mergedSkills: [],
    availableSkills: [],
    browserProvider: "playwright" as const,
    disabledSkills: new Set<string>(),
  }
  const registry = createToolRegistry({
    ctx,
    pluginConfig,
    managers,
    skillContext,
    availableCategories: [],
    interactiveBashEnabled: true,
  })

  return Object.entries(registry.filteredTools)
    .filter(([, definition]) => (
      Object.hasOwn(definition.args, "category")
      || Object.hasOwn(definition.args, "subagent_type")
    ))
    .map(([name]) => name)
    .sort()
}
