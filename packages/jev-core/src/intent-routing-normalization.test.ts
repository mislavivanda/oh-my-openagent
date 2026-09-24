import { describe, expect, test } from "bun:test"
import {
  BuiltinAgentNameSchema,
  OverridableAgentNameSchema,
} from "../../omo-opencode/src/config/schema/agent-names"
import { DEFAULT_CATEGORIES } from "../../omo-opencode/src/tools/delegate-task/constants"
import type { IntentRoutingChoiceAnswer } from "./intent-routing-record"

type NormalizationModule = typeof import("./intent-routing-normalization")

const modulePath: string = "./intent-routing-normalization"
const loadedModule = await import(modulePath).catch(() => null)
const normalizationModule = loadedModule as NormalizationModule | null

function requireNormalizationModule(): NormalizationModule {
  expect(
    normalizationModule,
    "intent-routing normalization must exist before delegation routes can be scored",
  ).not.toBeNull()
  if (normalizationModule === null) {
    throw new Error("intent-routing normalization is unavailable")
  }
  return normalizationModule
}

function choiceAnswer(choice: string): IntentRoutingChoiceAnswer {
  return {
    choice,
    confidence: 1,
    probabilities: { [choice]: 1 },
    valid: true,
  }
}

describe("intent-routing observed delegation normalization", () => {
  test("#given built-in custom and absent category names #when normalizing against offered categories #then only offered values are category routes", () => {
    const { normalizeObservedDelegation } = requireNormalizationModule()
    const offeredCategories = [
      { name: "deep", description: "Built-in category." },
      { name: "project-special", description: "Configured custom category." },
    ]

    expect(normalizeObservedDelegation(
      { tool: "task", category: "deep" },
      offeredCategories,
    )).toEqual({
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
    })
    expect(normalizeObservedDelegation(
      { tool: "task", category: "project-special" },
      offeredCategories,
    )).toEqual({
      normalizedCategory: "project-special",
      normalizedSubagent: "none",
      routeClass: "category",
    })
    expect(normalizeObservedDelegation(
      { tool: "task", category: "never-offered" },
      offeredCategories,
    )).toEqual({
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unknown",
    })
  })

  test.each([
    {
      rule: "requested subagent precedence",
      args: {
        tool: "task",
        requested_subagent_type: "oracle",
        subagent_type: "sisyphus-junior",
      },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "oracle",
        routeClass: "subagent",
      },
    },
    {
      rule: "category-only routing",
      args: { tool: "task", category: "deep" },
      expected: {
        normalizedCategory: "deep",
        normalizedSubagent: "none",
        routeClass: "category",
      },
    },
    {
      rule: "category rewrite to sisyphus-junior",
      args: { tool: "task", category: "deep", subagent_type: "sisyphus-junior" },
      expected: {
        normalizedCategory: "deep",
        normalizedSubagent: "none",
        routeClass: "category",
      },
    },
    {
      rule: "subagent-only routing",
      args: { tool: "call_omo_agent", subagent_type: "explore" },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "explore",
        routeClass: "subagent",
      },
    },
    {
      rule: "task resume without routing fields",
      args: { tool: "task", task_id: "ses_x" },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unscorable_resume",
      },
    },
    {
      rule: "unrecognized category",
      args: { tool: "task", category: "not-a-runtime-category" },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unknown",
      },
    },
    {
      rule: "unrecognized subagent",
      args: { tool: "task", subagent_type: "general" },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "unknown",
      },
    },
    {
      rule: "no delegation",
      args: { tool: "task" },
      expected: {
        normalizedCategory: "none",
        normalizedSubagent: "none",
        routeClass: "none",
      },
    },
  ])("#given $rule #when normalizing observed args #then the route class is preserved", ({ args, expected }) => {
    const { normalizeObservedDelegation } = requireNormalizationModule()
    const offeredCategories = [{ name: "deep", description: "Offered category." }]
    expect(normalizeObservedDelegation(args, offeredCategories)).toEqual(expected)
  })
})

describe("intent-routing derived route", () => {
  test.each([
    {
      routeClass: "none" as const,
      normalizedCategory: "none",
      normalizedSubagent: "none",
      expected: { kind: "scorable", route: "none" },
    },
    {
      routeClass: "category" as const,
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      expected: { kind: "scorable", route: "category:deep" },
    },
    {
      routeClass: "subagent" as const,
      normalizedCategory: "none",
      normalizedSubagent: "explore",
      expected: { kind: "scorable", route: "subagent:explore" },
    },
    {
      routeClass: "unscorable_resume" as const,
      normalizedCategory: "none",
      normalizedSubagent: "none",
      expected: { kind: "unscorable", reason: "resume" },
    },
    {
      routeClass: "unknown" as const,
      normalizedCategory: "none",
      normalizedSubagent: "none",
      expected: { kind: "unscorable", reason: "unknown" },
    },
  ])(
    "#given routeClass $routeClass #when deriving the joint route #then every class has an explicit result",
    ({ routeClass, normalizedCategory, normalizedSubagent, expected }) => {
      const { deriveRoute } = requireNormalizationModule()
      expect(deriveRoute({ routeClass, normalizedCategory, normalizedSubagent })).toEqual(expected)
    },
  )

  test.each([
    ["none", "none", { route: "none", coherent: true }],
    ["deep", "none", { route: "category:deep", coherent: true }],
    ["none", "explore", { route: "subagent:explore", coherent: true }],
    ["deep", "explore", { route: null, coherent: false }],
  ] as const)(
    "#given category %s and subagent %s #when deriving a prediction #then coherence matches the harness domain",
    (category, subagent, expected) => {
      const { derivePredictedRoute } = requireNormalizationModule()
      expect(derivePredictedRoute({
        category: choiceAnswer(category),
        subagent: choiceAnswer(subagent),
      })).toEqual(expected)
    },
  )
})

describe("intent-routing subagent vocabulary", () => {
  test("#given the live built-in enum #when comparing the vocabulary #then no member drifts without an exclusion", () => {
    const { INTENT_ROUTING_SUBAGENT_VOCABULARY } = requireNormalizationModule()
    const documentedExclusions: Readonly<Record<string, string>> = {}
    const missing = BuiltinAgentNameSchema.options.filter(
      (agent) => !INTENT_ROUTING_SUBAGENT_VOCABULARY.includes(agent) && !(agent in documentedExclusions),
    )
    expect(missing, `missing built-in subagents: ${missing.join(", ")}`).toEqual([])
  })

  test("#given both live agent enums #when comparing the vocabulary #then only admitted names are present", () => {
    const { INTENT_ROUTING_SUBAGENT_VOCABULARY } = requireNormalizationModule()
    const vocabulary: readonly string[] = INTENT_ROUTING_SUBAGENT_VOCABULARY
    const liveNames = [...new Set([
      ...BuiltinAgentNameSchema.options,
      ...OverridableAgentNameSchema.options,
    ])]
    expect(vocabulary).toEqual(liveNames)
    expect(vocabulary).not.toContain("general")
  })
})

describe("intent-routing category vocabulary", () => {
  test("#given production built-in categories #when comparing the category vocabulary #then no member drifts", () => {
    const { INTENT_ROUTING_CATEGORY_VOCABULARY } = requireNormalizationModule()
    const vocabulary: readonly string[] = INTENT_ROUTING_CATEGORY_VOCABULARY
    const liveNames = Object.keys(DEFAULT_CATEGORIES)
    const missing = liveNames.filter((category) => !vocabulary.includes(category))
    const stale = vocabulary.filter((category) => !liveNames.includes(category))

    expect(missing, `missing built-in categories: ${missing.join(", ")}`).toEqual([])
    expect(stale, `stale built-in categories: ${stale.join(", ")}`).toEqual([])
  })
})
