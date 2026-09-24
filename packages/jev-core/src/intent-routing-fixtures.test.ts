import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_FIXTURES,
  INTENT_ROUTING_FIXTURE_SOURCES,
} from "./intent-routing-fixtures"
import {
  INTENT_ROUTING_CATEGORY_VOCABULARY,
  INTENT_ROUTING_SUBAGENT_VOCABULARY,
} from "./intent-routing-normalization"

const allowedCategories = new Set<string>([...INTENT_ROUTING_CATEGORY_VOCABULARY, "none"])
const allowedSubagents = new Set<string>([...INTENT_ROUTING_SUBAGENT_VOCABULARY, "none"])
const NON_ASCII = /[^\u0000-\u007F]/

function offenders(predicate: (fixture: (typeof INTENT_ROUTING_FIXTURES)[number]) => boolean) {
  return INTENT_ROUTING_FIXTURES.filter(predicate).map((fixture) => fixture.id)
}

describe("intent-routing fixture coverage", () => {
  test("#given the hand-labeled fixture set #when its size is measured #then at least 15 fixtures exist", () => {
    expect(INTENT_ROUTING_FIXTURES.length).toBeGreaterThanOrEqual(15)
  })

  test("#given the fixture ids #when duplicates are collected #then every id is unique", () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const fixture of INTENT_ROUTING_FIXTURES) {
      if (seen.has(fixture.id)) duplicates.push(fixture.id)
      seen.add(fixture.id)
    }
    expect(duplicates).toEqual([])
  })

  test("#given every fixture category label #when checked against the category vocabulary #then no fixture names an unproducible category", () => {
    const invalid = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => !allowedCategories.has(fixture.label.category),
    ).map((fixture) => `${fixture.id} -> ${fixture.label.category}`)
    expect(invalid).toEqual([])
  })

  test("#given every fixture subagent label #when checked against the subagent vocabulary #then no fixture names an unproducible subagent", () => {
    const invalid = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => !allowedSubagents.has(fixture.label.subagent),
    ).map((fixture) => `${fixture.id} -> ${fixture.label.subagent}`)
    expect(invalid).toEqual([])
  })

  test("#given the no-delegation claim #when none-labeled fixtures are counted #then at least 3 carry category none", () => {
    const noneFixtures = offenders((fixture) => fixture.label.category === "none")
    expect(noneFixtures.length).toBeGreaterThanOrEqual(3)
  })

  test("#given the multilingual requirement #when non-ASCII prompts are counted #then at least 2 fixtures are non-English", () => {
    const nonEnglish = offenders((fixture) => NON_ASCII.test(fixture.input.promptText))
    expect(nonEnglish.length).toBeGreaterThanOrEqual(2)
  })

  test("#given the required source classes #when fixture sources are collected #then every class is represented", () => {
    const present = new Set(INTENT_ROUTING_FIXTURES.map((fixture) => fixture.source))
    const missing = INTENT_ROUTING_FIXTURE_SOURCES.filter((source) => !present.has(source))
    expect(missing).toEqual([])
  })

  test("#given the ambiguity ground truth #when noul values are range-checked #then every value sits inside the noul domain", () => {
    const outOfRange = offenders(
      (fixture) =>
        !Number.isFinite(fixture.label.ambiguous) ||
        fixture.label.ambiguous < 0 ||
        fixture.label.ambiguous > 1,
    )
    expect(outOfRange).toEqual([])
  })

  test("#given the known-weak continuation class #when its ambiguity is inspected #then every continuation fixture is labeled highly ambiguous", () => {
    const continuations = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.source === "CONTINUATION",
    )
    expect(continuations.length).toBeGreaterThanOrEqual(2)
    const underLabeled = continuations
      .filter((fixture) => fixture.label.ambiguous < 0.8)
      .map((fixture) => fixture.id)
    expect(underLabeled).toEqual([])
  })

  test("#given the obvious single-route classes #when their labels are inspected #then category and subagent fixtures stay single-route", () => {
    const wrongCategoryClass = INTENT_ROUTING_FIXTURES.filter(
      (fixture) =>
        fixture.source === "OBVIOUS_CATEGORY" &&
        (fixture.label.category === "none" || fixture.label.subagent !== "none"),
    ).map((fixture) => fixture.id)
    const wrongSubagentClass = INTENT_ROUTING_FIXTURES.filter(
      (fixture) =>
        fixture.source === "OBVIOUS_SUBAGENT" &&
        (fixture.label.subagent === "none" || fixture.label.category !== "none"),
    ).map((fixture) => fixture.id)
    expect({ wrongCategoryClass, wrongSubagentClass }).toEqual({
      wrongCategoryClass: [],
      wrongSubagentClass: [],
    })
  })
})
