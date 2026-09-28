import { describe, expect, test } from "bun:test"
import {
  derivePredictedRoute,
  deriveRoute,
  normalizeObservedDelegation,
  type DerivedRoute,
  type RouteObservation,
} from "./intent-routing-normalization"
import type {
  IntentRoutingAnswers,
  IntentRoutingObservedDelegation,
} from "./intent-routing-record"

const normalizationCases = [
  [
    "(a) requested_subagent_type wins over the rewritten subagent_type",
    {
      tool: "task",
      subagent_type: "sisyphus-junior",
      requested_subagent_type: "oracle",
    },
    {
      normalizedCategory: "none",
      normalizedSubagent: "oracle",
      routeClass: "subagent",
    },
  ],
  [
    "(b) category-only remains a category after the sisyphus-junior rewrite",
    { tool: "task", category: "deep", subagent_type: "sisyphus-junior" },
    {
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
    },
  ],
  [
    "(e) an unrecognized category remains unknown",
    { tool: "task", category: "totally-made-up" },
    {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unknown",
    },
  ],
  [
    "(c) subagent-only becomes a subagent route",
    { tool: "call_omo_agent", subagent_type: "explore" },
    {
      normalizedCategory: "none",
      normalizedSubagent: "explore",
      routeClass: "subagent",
    },
  ],
  [
    "(d) a task_id without routing fields is an unscorable resume",
    { tool: "task", task_id: "ses_x" },
    {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unscorable_resume",
    },
  ],
  [
    "(e) an unrecognized subagent remains unknown",
    { tool: "task", subagent_type: "not-registered" },
    {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unknown",
    },
  ],
] as const

describe("observed delegation normalization", () => {
  describe("#given raw delegation arguments covering every normalization rule", () => {
    describe("#when normalizing each delegation", () => {
      test.each(normalizationCases)("#then %s", (_name, args, expected) => {
        expect(normalizeObservedDelegation(args)).toEqual(expected)
      })
    })
  })

  describe("#given a task resume with no category or subagent", () => {
    describe("#when normalizing the resume", () => {
      test("#then it never becomes a none route", () => {
        const normalized = normalizeObservedDelegation({ tool: "task", task_id: "ses_x" })

        expect(normalized.routeClass).toBe("unscorable_resume")
        expect(normalized.routeClass).not.toBe("none")
      })
    })
  })

  describe("#given mutually exclusive category and requested-subagent targets", () => {
    describe("#when normalizing the delegation", () => {
      test("#then the contradictory state remains unknown", () => {
        // This contradictory-state case carries both routing targets that the tool contract forbids.
        const normalized = normalizeObservedDelegation({
          tool: "task",
          category: "deep",
          subagent_type: "sisyphus-junior",
          requested_subagent_type: "hephaestus",
        })

        expect(normalized).toEqual({
          normalizedCategory: "none",
          normalizedSubagent: "none",
          routeClass: "unknown",
        })
      })
    })
  })
})

const routeCases = {
  category: {
    observation: {
      normalizedCategory: "deep",
      normalizedSubagent: "none",
      routeClass: "category",
    },
    expected: { kind: "scorable", route: "category:deep" },
  },
  subagent: {
    observation: {
      normalizedCategory: "none",
      normalizedSubagent: "explore",
      routeClass: "subagent",
    },
    expected: { kind: "scorable", route: "subagent:explore" },
  },
  unscorable_resume: {
    observation: {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unscorable_resume",
    },
    expected: { kind: "unscorable", reason: "resume" },
  },
  unknown: {
    observation: {
      normalizedCategory: "none",
      normalizedSubagent: "none",
      routeClass: "unknown",
    },
    expected: { kind: "unscorable", reason: "unknown" },
  },
} satisfies Readonly<
  Record<
    IntentRoutingObservedDelegation["routeClass"],
    { readonly observation: RouteObservation; readonly expected: DerivedRoute }
  >
>

describe("observed route derivation", () => {
  describe("#given one observation for every routeClass value", () => {
    describe("#when deriving the scoring route", () => {
      test.each(Object.values(routeCases))("#then every class has an explicit result", ({ observation, expected }) => {
        expect(deriveRoute(observation)).toEqual(expected)
      })
    })
  })

  describe("#given no delegation observation", () => {
    describe("#when deriving the scoring route", () => {
      test("#then the turn is a scorable none route", () => {
        expect(deriveRoute(null)).toEqual({ kind: "scorable", route: "none" })
      })
    })
  })
})

function answers(category: string, subagent: string): IntentRoutingAnswers {
  return {
    intent: {
      choice: "implementation",
      confidence: 0.9,
      probabilities: { implementation: 0.9, research: 0.1 },
      valid: true,
    },
    category: {
      choice: category,
      confidence: 0.9,
      probabilities: { [category]: 0.9, none: category === "none" ? 0.9 : 0.1 },
      valid: true,
    },
    subagent: {
      choice: subagent,
      confidence: 0.9,
      probabilities: { [subagent]: 0.9, none: subagent === "none" ? 0.9 : 0.1 },
      valid: true,
    },
    ambiguous: { noul: 0.1, valid: true },
  }
}

describe("predicted route derivation", () => {
  describe("#given independent category and subagent Choice answers", () => {
    describe("#when deriving their joint scoring route", () => {
      test.each([
        ["none", "none", { route: "none", coherent: true }],
        ["deep", "none", { route: "category:deep", coherent: true }],
        ["none", "explore", { route: "subagent:explore", coherent: true }],
        ["deep", "explore", { route: "category:deep", coherent: false }],
      ] as const)("#then category %s and subagent %s produce the expected result", (category, subagent, expected) => {
        expect(derivePredictedRoute(answers(category, subagent))).toEqual(expected)
      })
    })
  })
})
