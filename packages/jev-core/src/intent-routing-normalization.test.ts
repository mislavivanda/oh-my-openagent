import { describe, expect, test } from "bun:test"
import type { IntentRoutingRouteClass } from "./intent-routing-record"
import {
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
  derivePredictedRoute,
  deriveRoute,
  normalizeObservedDelegation,
  type IntentRoutingDerivedRoute,
  type IntentRoutingPredictedRoute,
} from "./intent-routing-normalization"

describe("observed delegation normalization", () => {
  test.each([
    [
      "rule (a): requested_subagent_type overrides the rewritten subagent_type",
      {
        tool: "task",
        subagent_type: "sisyphus-junior",
        requested_subagent_type: "oracle",
      },
      { normalizedCategory: "none", normalizedSubagent: "oracle", routeClass: "subagent" },
    ],
    [
      "rule (b): a category survives the sisyphus-junior rewrite",
      { tool: "task", category: "deep", subagent_type: "sisyphus-junior" },
      { normalizedCategory: "deep", normalizedSubagent: "none", routeClass: "category" },
    ],
    [
      "rule (c): a direct subagent remains a subagent route",
      { tool: "call_omo_agent", subagent_type: "librarian" },
      { normalizedCategory: "none", normalizedSubagent: "librarian", routeClass: "subagent" },
    ],
    [
      "rule (d): a task resume without routing fields is unscorable",
      { tool: "task", task_id: "ses_x" },
      { normalizedCategory: "none", normalizedSubagent: "none", routeClass: "unscorable_resume" },
    ],
    [
      "rule (e): an unknown subagent is kept outside the scoring domain",
      { tool: "task", subagent_type: "nonexistent-agent" },
      { normalizedCategory: "none", normalizedSubagent: "none", routeClass: "unknown" },
    ],
  ])("#given %s #when normalizing #then the route class is explicit", (_name, args, expected) => {
    expect(
      normalizeObservedDelegation(args),
      `normalization failed for ${_name}`,
    ).toMatchObject(expected)
  })

  test("#given category and subagent together #when normalizing #then category wins like the task harness", () => {
    const result = normalizeObservedDelegation({
      tool: "task",
      category: "deep",
      subagent_type: "oracle",
    })

    expect(result).toMatchObject({
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
    })
  })

  test("#given task_id and an explicit route #when normalizing #then the explicit route wins", () => {
    const result = normalizeObservedDelegation({
      tool: "task",
      task_id: "ses_x",
      subagent_type: "explore",
    })

    expect(result.routeClass).toBe("subagent")
  })
})

describe("observed route derivation", () => {
  const expectedByClass = {
    category: { kind: "scorable", route: "category:deep" },
    subagent: { kind: "scorable", route: "subagent:oracle" },
    unscorable_resume: { kind: "unscorable", reason: "resume" },
    unknown: { kind: "unscorable", reason: "unknown" },
  } satisfies Record<IntentRoutingRouteClass, IntentRoutingDerivedRoute>

  const routeClasses = [
    "category",
    "subagent",
    "unscorable_resume",
    "unknown",
  ] as const satisfies readonly IntentRoutingRouteClass[]

  test("#given every routeClass #when deriving routes #then the result is total and discriminated", () => {
    for (const routeClass of routeClasses) {
      const observation = {
        routeClass,
        normalizedCategory: "deep",
        normalizedSubagent: "oracle",
      }

      expect(deriveRoute(observation)).toEqual(expectedByClass[routeClass])
    }
  })
})

describe("predicted route derivation", () => {
  const answer = (choice: string) => ({ choice })
  const coherentCases = [
    ["none", "none", { route: "none", coherent: true }],
    ["deep", "none", { route: "category:deep", coherent: true }],
    ["none", "oracle", { route: "subagent:oracle", coherent: true }],
  ] as const satisfies readonly (readonly [string, string, IntentRoutingPredictedRoute])[]

  test.each(coherentCases)(
    "#given category %s and subagent %s #when deriving #then the prediction is coherent",
    (category, subagent, expected) => {
      expect(derivePredictedRoute({ category: answer(category), subagent: answer(subagent) })).toEqual(expected)
    },
  )

  test("#given two non-none choices #when deriving #then no route is fabricated", () => {
    const result = derivePredictedRoute({
      category: answer("deep"),
      subagent: answer("oracle"),
    })

    expect(result).toEqual({ route: null, coherent: false })
  })
})

describe("subagent vocabulary", () => {
  test("#given the frozen vocabulary #when inspected #then it includes none and every admitted builtin", () => {
    expect(Object.isFrozen(INTENT_ROUTING_SUBAGENT_VOCABULARY)).toBe(true)
    expect(INTENT_ROUTING_SUBAGENT_VOCABULARY).toEqual([
      "none",
      "sisyphus",
      "hephaestus",
      "prometheus",
      "oracle",
      "librarian",
      "explore",
      "multimodal-looker",
      "metis",
      "momus",
      "atlas",
      "sisyphus-junior",
    ])
  })
})
