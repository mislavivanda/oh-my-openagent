import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
  COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  buildCompletionContinuationState,
  buildCompletionContinuationTodoStatusDigest,
  utf8ByteLength,
} from "./completion-continuation-state"

const EMPTY_INPUT = {
  todos: [],
  transcript: [],
  diff: { files: [] },
  boulder: { total: 0, completed: 0, remaining: 0, nextTaskTitle: null },
} as const

const AVAILABLE_PREVIOUS = {
  available: true,
  todoStatusDigest: `sha256:${"a".repeat(64)}`,
  boulderDigest: `sha256:${"b".repeat(64)}`,
  todo: { total: 4, completed: 1 },
  boulder: { total: 3, completed: 1, remaining: 2 },
  continuationDispatched: true,
} as const

describe("buildCompletionContinuationState", () => {
  test("#given a prior idle snapshot #when building state #then previous retains every grader input", () => {
    const result = buildCompletionContinuationState({ ...EMPTY_INPUT, previous: AVAILABLE_PREVIOUS })

    expect(result.state.previous).toEqual(AVAILABLE_PREVIOUS)
  })

  test("#given a first idle #when building state #then previous absence is explicit", () => {
    const result = buildCompletionContinuationState(EMPTY_INPUT)

    expect(result.state.previous).toEqual({ available: false, reason: "first_idle" })
  })

  test("#given inputs above every component cap #when building state #then exact item message path and byte caps apply", () => {
    const todos = Array.from({ length: 40 }, (_, index) => ({
      id: `todo-${index}`,
      status: index % 2 === 0 ? "pending" as const : "completed" as const,
      content: "x".repeat(257),
    }))
    const transcript = [
      { role: "system", content: "ignored", synthetic: false },
      { role: "assistant", content: "synthetic", synthetic: true },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:`.padEnd(1501, "m"),
        synthetic: false,
      })),
    ]
    const diff = {
      files: Array.from({ length: 40 }, (_, index) => ({
        path: `${index}:`.padEnd(257, "p"), additions: index, deletions: 1,
      })),
    }

    const result = buildCompletionContinuationState({
      todos, transcript, diff,
      boulder: { total: 1, completed: 0, remaining: 1, nextTaskTitle: "n".repeat(257) },
    })

    expect(result.state.todo.total).toBe(40)
    expect(result.state.todo.items).toHaveLength(32)
    expect(result.state.todo.items.every((item) => utf8ByteLength(item.content) <= 256)).toBe(true)
    expect(result.state.transcript.messages).toHaveLength(8)
    expect(result.state.transcript.messages[0]?.content.startsWith("2:")).toBe(true)
    expect(result.state.transcript.messages.reduce((sum, item) => sum + utf8ByteLength(item.content), 0)).toBeLessThanOrEqual(COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES)
    expect(result.state.diff?.fileCount).toBe(40)
    expect(result.state.diff?.paths.length).toBeLessThanOrEqual(32)
    expect(result.state.diff?.paths.reduce((sum, path) => sum + utf8ByteLength(path), 0)).toBeLessThanOrEqual(COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES)
    expect(utf8ByteLength(result.state.boulder?.nextTaskTitle ?? "")).toBe(256)
    expect(result.state.inputTruncations).toEqual({
      todoItems: true, todoContent: true,
      transcriptMessages: true, transcriptContent: true,
      diffPaths: true, diffContent: true,
      boulderContent: true, state: true,
    })
  })

  test("#given ordered and reordered todo statuses #when digesting #then the digest is reorder stable and status sensitive", () => {
    const first = [
      { id: "b", status: "pending" as const, content: "ignored" },
      { id: "a", status: "completed" as const, content: "also ignored" },
    ]
    const reordered = [first[1], first[0]].filter((item) => item !== undefined)
    const changed = [first[0], { id: "a", status: "pending" as const, content: "also ignored" }]

    expect(buildCompletionContinuationTodoStatusDigest(first)).toBe(
      buildCompletionContinuationTodoStatusDigest(reordered),
    )
    expect(buildCompletionContinuationTodoStatusDigest(first)).not.toBe(
      buildCompletionContinuationTodoStatusDigest(changed),
    )
  })

  test("#given state far above the final budget #when reducing #then stages run in the declared deterministic order", () => {
    const todos = Array.from({ length: 32 }, (_, index) => ({
      id: `${index}:`.padEnd(1000, "i"), status: "pending" as const, content: "c".repeat(256),
    }))
    const transcript = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", content: `${index}:`.padEnd(1500, "m"), synthetic: false,
    }))
    const diff = { files: Array.from({ length: 32 }, (_, index) => ({
      path: `${index}:`.padEnd(128, "p"), additions: 1, deletions: 1,
    })) }

    const result = buildCompletionContinuationState({ todos, transcript, diff, boulder: null, previous: AVAILABLE_PREVIOUS })

    console.log(`protectedReductionPreBytes=${result.preReductionBytes}`)
    console.log(`protectedReductionPostBytes=${result.serializedBytes}`)
    expect(result.preReductionBytes).toBeGreaterThan(COMPLETION_CONTINUATION_MAX_STATE_BYTES)
    expect(result.serializedBytes).toBeLessThan(result.preReductionBytes)
    expect(result.state.diff?.paths).toEqual([])
    expect(result.state.transcript.messages).toEqual([])
    expect(result.state.todo.items.length).toBeLessThan(32)
    expect(result.state.todo.items.every((item) => item.content === "")).toBe(true)
    expect(result.state.todo.items.map((item) => item.id)).toEqual(
      todos.slice(0, result.state.todo.items.length).map((item) => item.id),
    )
    expect(result.state.todo.statusDigest).toBe(buildCompletionContinuationTodoStatusDigest(todos))
    expect(result.state.inputDigests.todoStatus).toBe(result.state.todo.statusDigest)
    expect(result.state.previous).toEqual(AVAILABLE_PREVIOUS)
    expect(result.state.inputTruncations).toMatchObject({
      diffPaths: true, transcriptMessages: true, todoContent: true, todoItems: true, state: true,
    })
  })

  test("#given budget pressure reaching transcript reduction #when building #then oldest messages drop first", () => {
    const todos = Array.from({ length: 32 }, (_, index) => ({
      id: `${index}:`.padEnd(200, "i"), status: "pending" as const, content: "c".repeat(256),
    }))
    const transcript = Array.from({ length: 8 }, (_, index) => ({
      role: "user", content: `${index}:`.padEnd(1500, "m"), synthetic: false,
    }))
    const diff = { files: Array.from({ length: 32 }, (_, index) => ({
      path: `${index}:`.padEnd(128, "p"), additions: 1, deletions: 1,
    })) }

    const result = buildCompletionContinuationState({ todos, transcript, diff, boulder: null })
    const retainedIndexes = result.state.transcript.messages.map((message) => Number(message.content.split(":", 1)[0]))

    expect(result.state.diff?.paths).toEqual([])
    expect(retainedIndexes.length).toBeGreaterThan(0)
    expect(retainedIndexes).toEqual([...retainedIndexes].sort((left, right) => left - right))
    expect(retainedIndexes[0]).toBe(8 - retainedIndexes.length)
    expect(result.state.todo.items.every((item) => utf8ByteLength(item.content) === 256)).toBe(true)
  })

  test("caps multibyte state by UTF-8 bytes", () => {
    // given
    const multilingual = "한글日本語😀𐍈"
    const todos = Array.from({ length: 40 }, (_, index) => ({
      id: `${index}-${multilingual.repeat(80)}`, status: "pending" as const,
      content: multilingual.repeat(100),
    }))
    const transcript = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", content: multilingual.repeat(400), synthetic: false,
    }))
    const diff = { files: Array.from({ length: 40 }, (_, index) => ({
      path: `${index}-${multilingual.repeat(100)}`, additions: 1, deletions: 1,
    })) }

    // when
    const result = buildCompletionContinuationState({
      todos, transcript, diff,
      boulder: { total: 2, completed: 1, remaining: 1, nextTaskTitle: multilingual.repeat(100) },
      previous: AVAILABLE_PREVIOUS,
    })

    // then
    console.log(`preReductionBytes=${result.preReductionBytes}`)
    console.log(`postReductionBytes=${result.serializedBytes}`)
    expect(Buffer.byteLength(result.serialized, "utf8")).toBeLessThanOrEqual(24576)
    expect(result.serializedBytes).toBeLessThanOrEqual(COMPLETION_CONTINUATION_MAX_STATE_BYTES)
    expect(result.state.previous).toEqual(AVAILABLE_PREVIOUS)
    expect(result.serialized).not.toContain("�")
    expect(JSON.stringify(JSON.parse(result.serialized))).toBe(result.serialized)
    expect(result.state.todo.items.every((item) => utf8ByteLength(item.content) <= COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES)).toBe(true)
  })

  test("#given empty malformed and exact-boundary content #when building #then output remains valid bounded plain data", () => {
    const exact = `${"a".repeat(252)}😀`
    const result = buildCompletionContinuationState({
      todos: [
        { id: "empty", status: "pending", content: "" },
        { id: "space", status: "pending", content: "   " },
        { id: "boundary", status: "pending", content: `${exact}한` },
        { id: "surrogate", status: "pending", content: "\ud800x" },
      ],
      transcript: [
        { role: "user", content: "ignored", synthetic: true },
        { role: "assistant", content: `${"z".repeat(1496)}😀`, synthetic: false },
        { role: "user", content: `${"z".repeat(1500)}x`, synthetic: false },
        { role: "assistant", content: "z".repeat(12001), synthetic: false },
      ],
      diff: { files: Array.from({ length: 17 }, (_, index) => ({
        path: index === 0 ? `${"p".repeat(256)}x` : "p".repeat(256), additions: 0, deletions: 0,
      })) },
      boulder: { total: 0, completed: 0, remaining: 0, nextTaskTitle: `${exact}한` },
    })

    expect(result.state.todo.items.map((item) => item.content)).toEqual(["", "   ", exact, "\ud800x"])
    expect(result.state.transcript.messages.map((message) => utf8ByteLength(message.content))).toEqual([1500, 1500, 1500])
    expect(result.state.diff?.fileCount).toBe(17)
    expect(result.state.diff?.paths).toHaveLength(16)
    expect(result.state.diff?.paths.reduce((sum, path) => sum + utf8ByteLength(path), 0)).toBe(4096)
    expect(result.state.boulder?.total).toBe(0)
    expect(result.serialized).not.toContain("�")
    expect(result.serializedBytes).toBeLessThanOrEqual(COMPLETION_CONTINUATION_MAX_STATE_BYTES)
  })

  test("#given only synthetic transcript messages #when building #then transcript state is empty without losing required keys", () => {
    const result = buildCompletionContinuationState({
      ...EMPTY_INPUT,
      transcript: [{ role: "assistant", content: "synthetic", synthetic: true }],
    })

    expect(result.state.transcript.messages).toEqual([])
    expect(result.state.diff).toMatchObject({ fileCount: 0, paths: [] })
    expect(result.state.questionKeys).toEqual(["actually_complete", "progressing", "stuck"])
    expect(result.state.todo.statusDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("#given core state sources #when auditing imports #then no OpenCode dependency is present", async () => {
    const sources = await Promise.all([
      readFile(new URL("completion-continuation-state.ts", import.meta.url), "utf8"),
      readFile(new URL("completion-continuation-state-budget.ts", import.meta.url), "utf8"),
      readFile(new URL("completion-continuation-questions.ts", import.meta.url), "utf8"),
    ])

    expect(sources.join("\n")).not.toMatch(/@opencode-ai|omo-opencode/)
  })
})
