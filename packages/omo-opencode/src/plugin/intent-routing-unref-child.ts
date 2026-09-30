import { OhMyOpenCodeConfigSchema } from "../config"
import { setMainSession } from "../features/claude-code-session-state"
import { createJevIntentRouting } from "../features/jev"
import { createPluginModule } from "../testing/create-plugin-module"
import { intentRoutingPluginDeps } from "../testing/jev-intent-routing-test-fixture"

let signalRequestStarted: (() => void) | undefined
const requestStarted = new Promise<void>((resolve) => { signalRequestStarted = resolve })
const pluginConfig = OhMyOpenCodeConfigSchema.parse({
  jev: {
    enabled: true,
    backend: "real",
    model: "jev-inert-child",
    wires: {
      intent_routing: {
        enabled: true,
        timeout_ms: 100,
        turn_seal_timeout_ms: 1000,
      },
    },
  },
})
const plugin = createPluginModule(intentRoutingPluginDeps({
  loadConfigChain: () => ({ config: pluginConfig, messages: [], path: null, valid: true }),
  createJevIntentRouting: (args) => {
    const routing = createJevIntentRouting({
      ...args,
      env: {
        TYPESAFE_API_KEY: "test-key",
        OMO_JEV_BASE_URL: "http://127.0.0.1:9",
      },
      fetch: async () => {
        signalRequestStarted?.()
        return new Promise<Response>(() => {})
      },
      logger: (message, data) => process.stdout.write(`${message} ${JSON.stringify(data)}\n`),
    })
    process.stdout.write(`ROUTING_ENABLED=${routing.enabled}\n`)
    return routing
  },
}))

const hooks = await plugin.server({
  directory: process.cwd(),
  client: { tui: { showToast: async () => ({}) } },
} as Parameters<typeof plugin.server>[0])
process.stdout.write("PLUGIN_READY\n")
setMainSession("main")
const chatMessage = hooks["chat.message"]
if (chatMessage === undefined) throw new TypeError("chat.message hook is unavailable")
await chatMessage(
  { sessionID: "main", agent: "sisyphus" },
  {
    message: {
      id: "message-1",
      sessionID: "main",
      role: "user",
      time: { created: Date.now() },
      agent: "sisyphus",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{
      id: "part-1",
      sessionID: "main",
      messageID: "message-1",
      type: "text",
      text: "leave backend hanging",
    }],
  },
)
process.stdout.write("HANDLER_RETURNED\n")
let deadline: ReturnType<typeof setTimeout> | undefined
await Promise.race([
  requestStarted,
  new Promise<void>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("backend did not start")), 500)
  }),
])
if (deadline !== undefined) clearTimeout(deadline)
process.stdout.write("BACKEND_IN_FLIGHT\n")
