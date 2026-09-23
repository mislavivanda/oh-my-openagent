import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  MODEL_ERROR_TRIAGE_FIXTURES,
  type ModelErrorTriageFixtureSource,
} from "@oh-my-opencode/jev-core"
import { isRetryableModelError } from "../../shared/model-error-classifier"

const CLASSIFIER_LIST_NAMES = [
  "RETRYABLE_ERROR_NAMES",
  "STOP_ERROR_NAMES",
  "NON_RETRYABLE_ERROR_NAMES",
  "RETRYABLE_MESSAGE_PATTERNS",
  "STOP_MESSAGE_PATTERNS",
] as const satisfies readonly ModelErrorTriageFixtureSource[]

type ClassifierListName = (typeof CLASSIFIER_LIST_NAMES)[number]

const EXPECTED_LITERAL_COUNTS: Record<ClassifierListName, number> = {
  RETRYABLE_ERROR_NAMES: 5,
  STOP_ERROR_NAMES: 3,
  NON_RETRYABLE_ERROR_NAMES: 7,
  RETRYABLE_MESSAGE_PATTERNS: 46,
  STOP_MESSAGE_PATTERNS: 27,
}

function extractListLiterals(source: string, listName: ClassifierListName): readonly string[] {
  const assignment = `const ${listName} = `
  const assignmentIndex = source.indexOf(assignment)
  if (assignmentIndex < 0) {
    throw new TypeError(`Missing classifier list ${listName}`)
  }

  const remainder = source.slice(assignmentIndex + assignment.length)
  const terminator = /^\]\)?\r?$/m.exec(remainder)
  if (terminator?.index === undefined) {
    throw new TypeError(`Missing classifier list terminator for ${listName}`)
  }

  const block = remainder.slice(0, terminator.index)
  // The five classifier lists contain no "//" literals, so the first marker starts a comment.
  const commentFreeBlock = block
    .split(/\r?\n/)
    .map((line) => {
      const commentIndex = line.indexOf("//")
      return commentIndex < 0 ? line : line.slice(0, commentIndex)
    })
    .join("\n")
  return [...commentFreeBlock.matchAll(/"([^"]*)"/g)].map((match) => {
    const literal = match[1]
    if (literal === undefined) {
      throw new TypeError(`Could not extract a literal from ${listName}`)
    }
    return literal
  })
}

describe("model-error triage fixture coverage", () => {
  test("#given every model-error triage fixture #when checked with the real heuristic #then fixture agreement holds", () => {
    for (const fixture of MODEL_ERROR_TRIAGE_FIXTURES) {
      expect(isRetryableModelError(fixture.input)).toBe(fixture.heuristicShouldRetry)
    }
  })

  test("#given the classifier source text #when completeness extraction parses all five lists #then every literal has the correctly attributed fixture", async () => {
    const classifierPath = resolve(
      import.meta.dir,
      "../../../../model-core/src/model-error-classifier.ts",
    )
    expect(existsSync(classifierPath)).toBe(true)
    const source = await readFile(classifierPath, "utf8")
    const stopLiterals = new Set(extractListLiterals(source, "STOP_MESSAGE_PATTERNS"))
    const missing: string[] = []

    for (const listName of CLASSIFIER_LIST_NAMES) {
      const literals = extractListLiterals(source, listName)
      expect(literals).toHaveLength(EXPECTED_LITERAL_COUNTS[listName])
      const inputField = listName.endsWith("_ERROR_NAMES") ? "name" : "message"

      for (const literal of literals) {
        const expectedSource = stopLiterals.has(literal) ? "STOP_MESSAGE_PATTERNS" : listName
        const covered = MODEL_ERROR_TRIAGE_FIXTURES.some(
          (fixture) =>
            fixture.source === expectedSource && fixture.input[inputField] === literal,
        )
        if (!covered) {
          missing.push(`${listName}:${literal}->${expectedSource}`)
        }
      }
    }

    expect(missing).toEqual([])
  })
})
