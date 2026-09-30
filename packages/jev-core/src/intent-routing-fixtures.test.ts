import { describe, expect, test } from "bun:test"
import { buildIntentRoutingQuestions } from "./intent-routing"
import {
  INTENT_ROUTING_FIXTURES,
  type IntentRoutingFixtureSource,
} from "./intent-routing-fixtures"
import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "./intent-routing-normalization"

const CATEGORY_NAMES = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const

const INTENT_NAMES = [
  "research",
  "implementation",
  "investigation",
  "evaluation",
  "fix",
  "open-ended",
] as const

const REQUIRED_MINIMUM_BY_SOURCE = {
  "no-delegation": 3,
  "single-category": 2,
  "single-subagent": 2,
  ambiguous: 2,
  multilingual: 2,
  continuation: 2,
  adversarial: 2,
} as const satisfies Record<IntentRoutingFixtureSource, number>

const QUESTIONS = buildIntentRoutingQuestions({
  categories: CATEGORY_NAMES.map((name) => ({ name, description: name })),
  subagents: INTENT_ROUTING_SUBAGENT_VOCABULARY.filter((name) => name !== "none").map(
    (name) => ({ name, description: name }),
  ),
  intents: INTENT_NAMES.map((name) => ({ name, description: name })),
})

const VALID_FIXTURE = {
  id: "validator-probe",
  input: { promptText: "Review the proposed routing." },
  label: {
    intent: "evaluation",
    category: "none",
    subagent: "oracle",
    ambiguous: 0.2,
  },
  source: "single-subagent",
} as const

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateFixtures(fixtures: readonly unknown[]): readonly string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const intentOptions = new Set(Object.keys(QUESTIONS.intent.criteria))
  const categoryOptions = new Set(Object.keys(QUESTIONS.category.criteria))
  const subagentOptions = new Set(Object.keys(QUESTIONS.subagent.criteria))
  const sources = new Set(Object.keys(REQUIRED_MINIMUM_BY_SOURCE))

  for (const [index, fixture] of fixtures.entries()) {
    if (!isRecord(fixture)) {
      errors.push(`fixture[${index}]: must be an object`)
      continue
    }

    const id = typeof fixture.id === "string" && fixture.id.trim() !== ""
      ? fixture.id
      : `fixture[${index}]`
    if (ids.has(id)) errors.push(`${id}: duplicate id`)
    ids.add(id)

    if (!isRecord(fixture.input) || typeof fixture.input.promptText !== "string" || fixture.input.promptText.trim() === "") {
      errors.push(`${id}: input.promptText must be non-empty`)
    }
    if (!isRecord(fixture.label)) {
      errors.push(`${id}: label must be an object`)
    } else {
      if (typeof fixture.label.intent !== "string" || !intentOptions.has(fixture.label.intent)) {
        errors.push(`${id}: unknown intent`)
      }
      if (typeof fixture.label.category !== "string" || !categoryOptions.has(fixture.label.category)) {
        errors.push(`${id}: unknown category`)
      }
      if (typeof fixture.label.subagent !== "string" || !subagentOptions.has(fixture.label.subagent)) {
        errors.push(`${id}: unknown subagent`)
      }
      if (typeof fixture.label.ambiguous !== "number" || !Number.isFinite(fixture.label.ambiguous) || fixture.label.ambiguous < 0 || fixture.label.ambiguous > 1) {
        errors.push(`${id}: ambiguous must be between 0 and 1`)
      }
    }
    if (typeof fixture.source !== "string" || !sources.has(fixture.source)) {
      errors.push(`${id}: unknown source`)
    }
  }

  return errors
}

describe("intent-routing fixtures", () => {
  test("#given the hand-labeled fixture set #when validating its contract #then every fixture is valid and uniquely identified", () => {
    expect(INTENT_ROUTING_FIXTURES.length).toBeGreaterThanOrEqual(15)
    expect(validateFixtures(INTENT_ROUTING_FIXTURES)).toEqual([])
  })

  test("#given required coverage classes #when counting fixture sources #then every minimum is met", () => {
    for (const [source, minimum] of Object.entries(REQUIRED_MINIMUM_BY_SOURCE)) {
      const count = INTENT_ROUTING_FIXTURES.filter((fixture) => fixture.source === source).length
      expect(count, source).toBeGreaterThanOrEqual(minimum)
    }
  })

  test("#given headline no-delegation fixtures #when inspecting their routes #then at least three select neither delegation kind", () => {
    const noDelegation = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.label.category === "none" && fixture.label.subagent === "none",
    )
    expect(noDelegation.length).toBeGreaterThanOrEqual(3)
  })

  test("#given multilingual fixtures #when inspecting prompt text #then at least two contain non-ASCII language data", () => {
    const nonEnglish = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.source === "multilingual" && /[^\u0000-\u007f]/u.test(fixture.input.promptText),
    )
    expect(nonEnglish.length).toBeGreaterThanOrEqual(2)
  })

  test("#given ambiguous fixtures #when inspecting hand labels #then at least two carry high ambiguity", () => {
    const highAmbiguity = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.source === "ambiguous" && fixture.label.ambiguous >= 0.75,
    )
    expect(highAmbiguity.length).toBeGreaterThanOrEqual(2)
  })

  test.each([
    ["duplicate id", [VALID_FIXTURE, VALID_FIXTURE], "duplicate id"],
    ["empty prompt", [{ ...VALID_FIXTURE, input: { promptText: "" } }], "input.promptText must be non-empty"],
    ["unknown category", [{ ...VALID_FIXTURE, label: { ...VALID_FIXTURE.label, category: "nonexistent-category" } }], "unknown category"],
    ["unknown subagent", [{ ...VALID_FIXTURE, label: { ...VALID_FIXTURE.label, subagent: "nonexistent-agent" } }], "unknown subagent"],
    ["missing source", [{ id: VALID_FIXTURE.id, input: VALID_FIXTURE.input, label: VALID_FIXTURE.label }], "unknown source"],
    ["unknown intent", [{ ...VALID_FIXTURE, label: { ...VALID_FIXTURE.label, intent: "nonexistent-intent" } }], "unknown intent"],
  ])("#given a fixture with %s #when validating #then the fixture id and issue are reported", (_case, fixtures, issue) => {
    expect(validateFixtures(fixtures)).toContain(`${VALID_FIXTURE.id}: ${issue}`)
  })
})
