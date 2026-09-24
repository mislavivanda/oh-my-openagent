import { describe, expect, test } from "bun:test"
import {
  INTENT_ROUTING_FIXTURES,
  INTENT_ROUTING_FIXTURE_CATEGORIES,
  INTENT_ROUTING_FIXTURE_SOURCES,
} from "./intent-routing-fixtures"
import { INTENT_ROUTING_NONE_OPTION } from "./intent-routing"
import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "./intent-routing-normalization"

const categoryOptions = new Set<string>([
  ...INTENT_ROUTING_FIXTURE_CATEGORIES,
  INTENT_ROUTING_NONE_OPTION,
])
const subagentOptions = new Set<string>([
  ...INTENT_ROUTING_SUBAGENT_VOCABULARY,
  INTENT_ROUTING_NONE_OPTION,
])

const NON_ASCII = /[^\u0000-\u007F]/

describe("intent-routing fixtures", () => {
  test("#given the hand-labeled corpus #when counted #then it holds at least 15 fixtures", () => {
    expect(INTENT_ROUTING_FIXTURES.length).toBeGreaterThanOrEqual(15)
  })

  test("#given the hand-labeled corpus #when ids are collected #then every id is unique", () => {
    const ids = INTENT_ROUTING_FIXTURES.map((fixture) => fixture.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("#given each fixture #when its category label is checked #then it is inside the category option set", () => {
    for (const fixture of INTENT_ROUTING_FIXTURES) {
      expect(
        categoryOptions.has(fixture.label.category),
        `fixture ${fixture.id} labels category "${fixture.label.category}" which the question set cannot produce`
      ).toBe(true)
    }
  })

  test("#given each fixture #when its subagent label is checked #then it is inside the subagent option set", () => {
    for (const fixture of INTENT_ROUTING_FIXTURES) {
      expect(
        subagentOptions.has(fixture.label.subagent),
        `fixture ${fixture.id} labels subagent "${fixture.label.subagent}" which the question set cannot produce`
      ).toBe(true)
    }
  })

  test("#given the corpus #when none-labeled fixtures are counted #then at least 3 carry the none category", () => {
    const noneFixtures = INTENT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.label.category === INTENT_ROUTING_NONE_OPTION
    )
    expect(noneFixtures.length).toBeGreaterThanOrEqual(3)
  })

  test("#given the corpus #when prompts are scanned for non-ASCII text #then at least 2 fixtures are non-English", () => {
    const multilingual = INTENT_ROUTING_FIXTURES.filter((fixture) =>
      NON_ASCII.test(fixture.input.promptText)
    )
    expect(multilingual.length).toBeGreaterThanOrEqual(2)
  })

  test("#given the required source classes #when the corpus is grouped by source #then every class is present", () => {
    const present = new Set(INTENT_ROUTING_FIXTURES.map((fixture) => fixture.source))
    for (const source of INTENT_ROUTING_FIXTURE_SOURCES) {
      expect(present.has(source), `no fixture carries source ${source}`).toBe(true)
    }
  })
})
