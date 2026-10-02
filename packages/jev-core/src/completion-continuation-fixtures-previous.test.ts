import { describe, expect, test } from "bun:test"
import { COMPLETION_CONTINUATION_FIXTURES } from "./completion-continuation-fixtures"

function requireFixture(id: string) {
  const fixture = COMPLETION_CONTINUATION_FIXTURES.find((candidate) => candidate.id === id)
  if (fixture === undefined) throw new TypeError(`Missing fixture ${id}`)
  return fixture
}

describe("completion-continuation fixture previous state", () => {
  test("#given progress and stuck cohorts #when predecessor inputs are inspected #then every delta case has a real previous block", () => {
    const deltaFixtures = COMPLETION_CONTINUATION_FIXTURES.filter((fixture) =>
      fixture.cohorts.includes("progressing") || fixture.cohorts.includes("stuck"),
    )

    expect(deltaFixtures.map((fixture) => fixture.id)).toHaveLength(10)
    expect(deltaFixtures.every((fixture) => fixture.input.previous?.available === true)).toBeTrue()
  })

  test("#given the completed first-idle fixture #when predecessor input is inspected #then absence is explicit", () => {
    const fixture = requireFixture("complete-all-todos-verified")

    expect(fixture.input.previous).toEqual({ available: false, reason: "first_idle" })
  })
})
