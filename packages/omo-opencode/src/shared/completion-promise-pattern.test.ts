/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { containsCompletionPromise } from "./completion-promise-pattern"

type PromiseCase = {
	readonly name: string
	readonly text: string
	readonly promise: string
	readonly expected: boolean
}

const PRE_EXTRACTION_TEXT_CASES: readonly PromiseCase[] = [
	{ name: "plain text", text: "Finished <promise>DONE</promise>", promise: "DONE", expected: true },
	{ name: "plain text miss", text: "Still working", promise: "DONE", expected: false },
	{ name: "case variation", text: "<PROMISE>done</PROMISE>", promise: "DONE", expected: true },
	{ name: "whitespace variation", text: "<promise>\n  DONE\t </promise>", promise: "DONE", expected: true },
]

const MALFORMED_INPUT_CASES: readonly PromiseCase[] = [
	{ name: "empty text", text: "", promise: "DONE", expected: false },
	{ name: "empty promise", text: "<promise></promise>", promise: "", expected: true },
	{ name: "whitespace-only promise", text: "<promise>   </promise>", promise: "   ", expected: true },
	{ name: "partial markup", text: "<promise>DONE", promise: "DONE", expected: false },
	{ name: "lone backslash", text: "<promise>\\</promise>", promise: "\\", expected: true },
	{ name: "unterminated character class", text: "<promise>[abc</promise>", promise: "[abc", expected: true },
]

describe("containsCompletionPromise", () => {
	test("matches the pre-extraction text golden table", () => {
		for (const row of PRE_EXTRACTION_TEXT_CASES) {
			expect(containsCompletionPromise(row.text, row.promise), row.name).toBe(row.expected)
		}
	})

	test("escapes a custom promise containing regex metacharacters", () => {
		const promise = "a.c*+(x)[y]?|\\"

		expect(containsCompletionPromise(`<promise>${promise}</promise>`, promise)).toBe(true)
		expect(containsCompletionPromise("<promise>abc</promise>", "a.c")).toBe(false)
	})

	test("handles malformed inputs without throwing", () => {
		for (const row of MALFORMED_INPUT_CASES) {
			expect(containsCompletionPromise(row.text, row.promise), row.name).toBe(row.expected)
		}
	})
})
