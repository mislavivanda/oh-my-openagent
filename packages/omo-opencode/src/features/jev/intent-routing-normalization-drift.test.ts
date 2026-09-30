import { describe, expect, test } from "bun:test"
import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "@oh-my-opencode/jev-core"
import {
  AgentNameSchema,
  BuiltinAgentNameSchema,
  OverridableAgentNameSchema,
} from "../../config/schema/agent-names"

const DOCUMENTED_BUILTIN_EXCLUSIONS = new Map<string, string>()

describe("intent-routing subagent vocabulary drift", () => {
  test("#given the live builtin registry #when compared #then every admitted agent is representable", () => {
    const vocabulary = new Set<string>(INTENT_ROUTING_SUBAGENT_VOCABULARY)
    const missing = BuiltinAgentNameSchema.options.filter(
      (name) => !vocabulary.has(name) && !DOCUMENTED_BUILTIN_EXCLUSIONS.has(name),
    )

    expect(
      missing,
      `INTENT_ROUTING_SUBAGENT_VOCABULARY is missing live registry members: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("#given native aliases #when checking the routing registry #then non-agent aliases stay excluded", () => {
    const routingRegistry = new Set<string>(AgentNameSchema.options)
    const overridableRegistry = new Set<string>(OverridableAgentNameSchema.options)
    const vocabulary = new Set<string>(INTENT_ROUTING_SUBAGENT_VOCABULARY)

    expect(overridableRegistry.has("plan")).toBe(true)
    expect(overridableRegistry.has("build")).toBe(true)
    expect(routingRegistry.has("plan")).toBe(false)
    expect(routingRegistry.has("general")).toBe(false)
    expect(routingRegistry.has("build")).toBe(false)
    expect(vocabulary.has("plan")).toBe(false)
    expect(vocabulary.has("general")).toBe(false)
    expect(vocabulary.has("build")).toBe(false)
  })
})
