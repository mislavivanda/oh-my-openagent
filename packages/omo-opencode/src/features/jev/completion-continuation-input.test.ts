/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  buildCompletionContinuationState,
  utf8ByteLength,
} from "@oh-my-opencode/jev-core"
import { createBoulderState, writeBoulderState } from "@oh-my-opencode/boulder-state"
import {
  scheduleCompletionContinuationBoulderSnapshot,
  type CompletionContinuationBoulderSnapshot,
} from "./completion-continuation-boulder-snapshot"
import { createCompletionContinuationDiffCache } from "./completion-continuation-diff-cache"
import {
  captureCompletionContinuationInput,
  finalizeCompletionContinuationInput,
} from "./completion-continuation-input"

const FIXED_NOW = 1_796_169_600_000

function createTestRoot(): string {
  return mkdtempSync(join(tmpdir(), "omo-jev-w2-input-test-"))
}

function observeDiff(
  cache: ReturnType<typeof createCompletionContinuationDiffCache>,
  sessionID: string,
  count = 1,
): void {
  cache.observeEvent({
    type: "session.diff",
    properties: {
      sessionID,
      diff: Array.from({ length: count }, (_, index) => ({
        file: `${index}:`.padEnd(300, "p"), before: `before-${index}`, after: `after-${index}`,
        additions: index + 1, deletions: index,
      })),
    },
  })
}

function deferredBoulderSnapshot(directory: string): Promise<CompletionContinuationBoulderSnapshot> {
  let synchronous = true
  const result = new Promise<CompletionContinuationBoulderSnapshot>((resolve) => {
    scheduleCompletionContinuationBoulderSnapshot({
      directory,
      now: () => FIXED_NOW,
      onSnapshot: (snapshot) => {
        expect(synchronous).toBe(false)
        resolve(snapshot)
      },
    })
  })
  synchronous = false
  return result
}

describe("completion-continuation OpenCode input", () => {
  test("#given every source above its cap #when captured synchronously #then state keeps aggregates and exact caps", () => {
    const todos = Array.from({ length: 40 }, (_, index) => ({
      id: `todo-${index}`,
      status: index % 2 === 0 ? "pending" : "completed",
      content: "t".repeat(300),
    }))
    const transcript = [
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:`.padEnd(1_600, "m"), synthetic: false,
      })),
      { role: "assistant", content: "synthetic-message", synthetic: true },
    ]
    const cache = createCompletionContinuationDiffCache({ now: () => FIXED_NOW })
    observeDiff(cache, "ses_caps", 40)

    const captured = captureCompletionContinuationInput({
      todos,
      transcript,
      diff: cache.getSnapshot("ses_caps"),
      now: () => FIXED_NOW,
    })
    const built = buildCompletionContinuationState(captured.input)

    console.log("preCapTodos=40 preCapTranscript=12 preCapDiff=40")
    expect(built.state.todo.total).toBe(40)
    expect(built.state.todo.items).toHaveLength(32)
    expect(built.state.todo.items.every((item) => utf8ByteLength(item.content) <= COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES)).toBe(true)
    expect(built.state.transcript.messages).toHaveLength(8)
    expect(built.state.transcript.messages[0]?.content.startsWith("4:")).toBe(true)
    expect(built.state.transcript.messages.reduce((sum, item) => sum + utf8ByteLength(item.content), 0)).toBeLessThanOrEqual(COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES)
    expect(JSON.stringify(built.state)).not.toContain("synthetic-message")
    expect(built.state.diff?.fileCount).toBe(40)
    expect(built.state.diff?.paths.length).toBeLessThanOrEqual(32)
    expect(built.state.diff?.paths.reduce((sum, path) => sum + utf8ByteLength(path), 0)).toBeLessThanOrEqual(COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES)
    expect(built.state.inputDigests).toEqual(captured.inputDigests)
  })

  test("does not retain FileDiff before or after content", () => {
    const sentinel = "W2_FILE_CONTENT_SENTINEL_9d8a2d"
    const cache = createCompletionContinuationDiffCache({ now: () => FIXED_NOW })
    cache.observeEvent({
      type: "session.diff",
      properties: { sessionID: "ses_secret", diff: [{
        file: "src/secret.ts", before: sentinel, after: `${sentinel}-after`, additions: 2, deletions: 1,
      }] },
    })

    const diff = cache.getSnapshot("ses_secret")
    const captured = captureCompletionContinuationInput({
      todos: [], transcript: [], diff, now: () => FIXED_NOW,
    })

    expect(JSON.stringify({ diff, captured })).not.toContain(sentinel)
  })

  test("#given absent stale and malformed inputs #when snapshots update #then availability is explicit and no path throws", () => {
    const cache = createCompletionContinuationDiffCache({ now: () => FIXED_NOW })
    expect(cache.getSnapshot("ses_stale").availability).toEqual({ status: "unavailable", reason: "no_event" })
    cache.observeEvent({ type: "session.diff", properties: { sessionID: "ses_stale", diff: [] } })
    expect(cache.getSnapshot("ses_stale").availability).toEqual({ status: "available", reason: null })
    cache.observeEvent({ type: "session.diff", properties: { sessionID: "ses_negative", diff: [
      { file: "bad.ts", before: "ignored", after: "ignored", additions: -1, deletions: 0 },
    ] } })
    cache.observeEvent({ type: "session.diff", properties: { sessionID: "ses_missing" } })
    cache.observeEvent({ type: "session.diff", properties: { diff: [] } })
    const captured = captureCompletionContinuationInput({
      todos: [],
      transcript: [{}, { role: "user", content: 42 }],
      diff: cache.getSnapshot("ses_negative"),
      now: () => FIXED_NOW,
    })

    expect(cache.getSnapshot("ses_negative").availability).toEqual({ status: "unavailable", reason: "malformed_event" })
    expect(cache.getSnapshot("ses_missing").availability).toEqual({ status: "unavailable", reason: "malformed_event" })
    expect(cache.inspect().malformedEvents).toBe(3)
    expect(captured.availability.todos).toMatchObject({ status: "available", sourceCount: 0, malformedCount: 0 })
    expect(captured.availability.transcript).toMatchObject({ status: "partial", sourceCount: 2, malformedCount: 2 })
  })

  test("#given 257 sessions #when the oldest untouched session exceeds capacity #then LRU stays at 256 and counts eviction", () => {
    const cache = createCompletionContinuationDiffCache({ now: () => FIXED_NOW })
    for (let index = 0; index < 256; index += 1) observeDiff(cache, `ses-${index}`)
    cache.getSnapshot("ses-0")
    observeDiff(cache, "ses-256")

    expect(cache.inspect()).toMatchObject({ sessionCount: 256, evictions: 1 })
    expect(cache.getSnapshot("ses-0").availability.status).toBe("available")
    expect(cache.getSnapshot("ses-1").availability).toEqual({ status: "unavailable", reason: "no_event" })
  })

  test("#given an explicit temp boulder plan #when the macrotask runs #then checklist summary and digest are captured", async () => {
    const root = createTestRoot()
    const planPath = join(root, ".omo", "plans", "work.md")
    const longTitle = "n".repeat(300)
    try {
      mkdirSync(dirname(planPath), { recursive: true })
      writeFileSync(planPath, `## TODOs\n- [x] 1. done\n- [ ] 2. ${longTitle}\n`)
      expect(writeBoulderState(root, createBoulderState(planPath, "ses_boulder"))).toBe(true)
      const boulder = await deferredBoulderSnapshot(root)
      const captured = captureCompletionContinuationInput({ todos: [], transcript: [], diff: null, now: () => FIXED_NOW })
      const finalized = finalizeCompletionContinuationInput(captured, boulder)

      console.log("preCapBoulderTitleBytes=303")
      expect(boulder.availability.status).toBe("available")
      expect(boulder.input).toMatchObject({ total: 2, completed: 1, remaining: 1 })
      expect(utf8ByteLength(boulder.input?.nextTaskTitle ?? "")).toBe(COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES)
      expect(boulder.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(buildCompletionContinuationState(finalized.input).state.inputDigests).toEqual(finalized.inputDigests)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given empty invalid zero-checkbox and missing plans #when deferred reads run #then each records unavailability", async () => {
    const cases = ["empty", "invalid", "zero", "missing"] as const
    for (const scenario of cases) {
      const root = createTestRoot()
      const planPath = join(root, ".omo", "plans", `${scenario}.md`)
      try {
        mkdirSync(dirname(planPath), { recursive: true })
        const content = scenario === "empty" ? "" : scenario === "invalid" ? "\0not markdown" : "# no checkboxes\n"
        writeFileSync(planPath, content)
        if (scenario === "missing") rmSync(planPath)
        expect(writeBoulderState(root, createBoulderState(planPath, `ses_${scenario}`))).toBe(true)
        const snapshot = await deferredBoulderSnapshot(root)
        expect(snapshot.availability.status).toBe("unavailable")
        expect(snapshot.input).toBeNull()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  test("#given owned production sources #when audited #then no shell or client diff request exists", async () => {
    const sources = await Promise.all([
      Bun.file(new URL("completion-continuation-input.ts", import.meta.url)).text(),
      Bun.file(new URL("completion-continuation-diff-cache.ts", import.meta.url)).text(),
      Bun.file(new URL("completion-continuation-boulder-snapshot.ts", import.meta.url)).text(),
    ])
    expect(sources.join("\n")).not.toMatch(/Bun\.spawn|child_process|session\.diff\(/)
  })
})
