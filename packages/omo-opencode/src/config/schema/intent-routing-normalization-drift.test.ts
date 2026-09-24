import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_CATEGORY_VOCABULARY,
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
} from "../../../../jev-core/src/intent-routing-normalization"
import { DEFAULT_CATEGORIES } from "../../tools/delegate-task/builtin-categories"
import { BuiltinAgentNameSchema } from "./agent-names"

const DOCUMENTED_EXCLUSIONS = new Map<string, string>()
const DOCUMENTED_CATEGORY_EXCLUSIONS = new Map<string, string>()

describe("intent-routing subagent vocabulary drift", () => {
  describe("#given the live built-in agent registry", () => {
    describe("#when comparing every schema option with the scoring vocabulary", () => {
      test("#then every member is included or has a documented exclusion", () => {
        const vocabulary = new Set<string>(INTENT_ROUTING_SUBAGENT_VOCABULARY)
        const missing = BuiltinAgentNameSchema.options.filter(
          (agent) => !vocabulary.has(agent) && !DOCUMENTED_EXCLUSIONS.has(agent),
        )

        expect(missing, `Missing intent-routing subagent vocabulary members: ${missing.join(", ")}`).toEqual([])
      })
    })
  })
})

describe("intent-routing category vocabulary drift", () => {
  describe("#given the live built-in category registry", () => {
    describe("#when comparing every default category with the scoring vocabulary", () => {
      test("#then every member is included or has a documented exclusion", () => {
        const vocabulary = new Set<string>(INTENT_ROUTING_CATEGORY_VOCABULARY)
        const missing = Object.keys(DEFAULT_CATEGORIES).filter(
          (category) => !vocabulary.has(category) && !DOCUMENTED_CATEGORY_EXCLUSIONS.has(category),
        )

        expect(missing, `Missing intent-routing category vocabulary members: ${missing.join(", ")}`).toEqual([])
      })
    })
  })
})
