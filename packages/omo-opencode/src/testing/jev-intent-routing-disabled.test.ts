import { describe, expect, it, mock } from "bun:test"
import { createPluginModule, type PluginModuleDeps } from "./create-plugin-module"
import { intentRoutingPluginDeps } from "./jev-intent-routing-test-fixture"

const disabledRouting = {
  enabled: false,
  inFlight: 0,
  dispatchesDropped: 0,
  observe(): void {},
  capture: () => false,
  sealSessionIdle: () => false,
  deleteSession(): void {},
  dispose: async (): Promise<void> => {},
}

const intentRoutingDefaults = {
  enabled: false,
  observe_only: true,
  confidence_threshold: 0.8,
  timeout_ms: 2500,
  turn_seal_timeout_ms: 120000,
  max_prompt_chars: 8000,
  max_inflight: 8,
}

const disabledConfigs = [
  ["jev absent", {}],
  ["jev disabled", {
    jev: {
      enabled: false,
      backend: "mock",
      model: "jev-latest",
      timeout_ms: 1500,
      wires: {
        model_error_triage: { enabled: false, confidence_threshold: 0.8 },
        intent_routing: { ...intentRoutingDefaults, enabled: true },
      },
    },
  }],
  ["intent-routing wire disabled", {
    jev: {
      enabled: true,
      backend: "mock",
      model: "jev-latest",
      timeout_ms: 1500,
      wires: {
        model_error_triage: { enabled: false, confidence_threshold: 0.8 },
        intent_routing: intentRoutingDefaults,
      },
    },
  }],
] as const

describe("Jev intent-routing disabled startup", () => {
  for (const [name, config] of disabledConfigs) {
    it(`#given ${name} #when the plugin initializes #then no sink or coordinator is constructed`, async () => {
      const createRouting = mock(() => disabledRouting)
      const createCoordinator = mock(() => {
        throw new Error("disabled path constructed a coordinator")
      })
      const createSink = mock(() => {
        throw new Error("disabled path constructed a sink")
      })
      const pluginModule = createPluginModule(intentRoutingPluginDeps({
        loadConfigChain: (() => ({ config: {}, messages: [], path: null, valid: true })) as PluginModuleDeps["loadConfigChain"],
        loadPluginConfig: (() => config) as PluginModuleDeps["loadPluginConfig"],
        createJevIntentRouting: createRouting,
        createIntentRoutingSealCoordinator: createCoordinator,
        createIntentRoutingSink: createSink,
      }))

      await expect(pluginModule.server({
        directory: "/tmp/jev-disabled",
        client: {},
      } as Parameters<typeof pluginModule.server>[0])).resolves.toBeDefined()

      expect(createRouting).toHaveBeenCalledTimes(1)
      expect(createCoordinator).not.toHaveBeenCalled()
      expect(createSink).not.toHaveBeenCalled()
    })
  }
})
