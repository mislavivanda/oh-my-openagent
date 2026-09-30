import { createHash } from "node:crypto"
import {
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  COMPLETION_CONTINUATION_TODO_ITEM_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES,
  buildCompletionContinuationTodoStatusDigest,
  truncateUtf8,
  utf8ByteLength,
  type CompletionContinuationInputDigests,
  type CompletionContinuationStateInput,
  type CompletionContinuationTodoInputItem,
  type CompletionContinuationTodoStatus,
  type CompletionContinuationTranscriptInputMessage,
} from "@oh-my-opencode/jev-core"
import type {
  CompletionContinuationBoulderAvailability,
  CompletionContinuationBoulderSnapshot,
} from "./completion-continuation-boulder-snapshot"
import type {
  CompletionContinuationDiffAvailability,
  CompletionContinuationDiffSnapshot,
} from "./completion-continuation-diff-cache"

export type CompletionContinuationTodoSource = {
  readonly id?: unknown
  readonly status?: unknown
  readonly content?: unknown
}

export type CompletionContinuationTranscriptSource = {
  readonly role?: unknown
  readonly content?: unknown
  readonly synthetic?: unknown
  readonly info?: { readonly role?: unknown }
  readonly parts?: readonly {
    readonly type?: unknown
    readonly text?: unknown
    readonly synthetic?: unknown
  }[]
}

export type CompletionContinuationSourceAvailability = {
  readonly status: "available" | "partial"
  readonly sourceCount: number
  readonly retainedCount: number
  readonly malformedCount: number
  readonly truncated: boolean
}

export type CompletionContinuationInputAvailability = {
  readonly todos: CompletionContinuationSourceAvailability
  readonly transcript: CompletionContinuationSourceAvailability
  readonly diff: CompletionContinuationDiffAvailability
  readonly boulder: CompletionContinuationBoulderAvailability | null
}

export type CompletionContinuationInputCaptureTimes = {
  readonly synchronous: number
  readonly diffObservedAt: number | null
  readonly diffReadAt: number | null
  readonly boulder: number | null
}

export type CompletionContinuationInputSnapshot = {
  readonly input: CompletionContinuationStateInput
  readonly inputDigests: CompletionContinuationInputDigests
  readonly availability: CompletionContinuationInputAvailability
  readonly capturedAt: CompletionContinuationInputCaptureTimes
}

export type CaptureCompletionContinuationInputOptions = {
  readonly todos: readonly CompletionContinuationTodoSource[]
  readonly transcript: readonly CompletionContinuationTranscriptSource[]
  readonly diff: CompletionContinuationDiffSnapshot | null
  readonly now?: () => number
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function isTodoStatus(value: unknown): value is CompletionContinuationTodoStatus {
  return value === "pending"
    || value === "in_progress"
    || value === "completed"
    || value === "cancelled"
}

function captureTodos(sources: readonly CompletionContinuationTodoSource[]): {
  readonly items: readonly CompletionContinuationTodoInputItem[]
  readonly availability: CompletionContinuationSourceAvailability
} {
  const valid: CompletionContinuationTodoInputItem[] = []
  let malformedCount = 0
  let contentTruncated = false
  for (const source of sources) {
    if (typeof source.id !== "string" || !isTodoStatus(source.status) || typeof source.content !== "string") {
      malformedCount += 1
      continue
    }
    const retainContent = valid.length < COMPLETION_CONTINUATION_TODO_ITEM_LIMIT
    const bounded = retainContent
      ? truncateUtf8(source.content, COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES)
      : { value: "", truncated: source.content.length > 0 }
    contentTruncated ||= bounded.truncated
    valid.push({ id: source.id, status: source.status, content: bounded.value })
  }
  return {
    items: valid,
    availability: {
      status: malformedCount === 0 ? "available" : "partial",
      sourceCount: sources.length,
      retainedCount: Math.min(valid.length, COMPLETION_CONTINUATION_TODO_ITEM_LIMIT),
      malformedCount,
      truncated: contentTruncated || valid.length > COMPLETION_CONTINUATION_TODO_ITEM_LIMIT,
    },
  }
}

function parseTranscriptSource(
  source: CompletionContinuationTranscriptSource,
): CompletionContinuationTranscriptInputMessage | "ignored" | null {
  if (source.role !== undefined || source.content !== undefined) {
    if (source.role !== "user" && source.role !== "assistant") {
      return source.role === undefined ? null : "ignored"
    }
    if (typeof source.content !== "string") return null
    return { role: source.role, content: source.content, synthetic: source.synthetic === true }
  }

  const role = source.info?.role
  if (role !== "user" && role !== "assistant") return role === undefined ? null : "ignored"
  if (!Array.isArray(source.parts)) return null
  const textParts = source.parts.filter((part) => part.type === "text")
  if (textParts.some((part) => typeof part.text !== "string")) return null
  return {
    role,
    content: textParts.map((part) => typeof part.text === "string" ? part.text : "").join("\n"),
    synthetic: textParts.some((part) => part.synthetic === true),
  }
}

function captureTranscript(sources: readonly CompletionContinuationTranscriptSource[]): {
  readonly messages: readonly CompletionContinuationTranscriptInputMessage[]
  readonly availability: CompletionContinuationSourceAvailability
} {
  const eligible: CompletionContinuationTranscriptInputMessage[] = []
  let malformedCount = 0
  let contentTruncated = false
  for (const source of sources) {
    const parsed = parseTranscriptSource(source)
    if (parsed === null) {
      malformedCount += 1
      continue
    }
    if (parsed === "ignored" || parsed.synthetic) continue
    const bounded = truncateUtf8(parsed.content, COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES)
    contentTruncated ||= bounded.truncated
    eligible.push({ ...parsed, content: bounded.value })
  }
  let messages = eligible.slice(-COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT)
  let retainedBytes = messages.reduce((sum, message) => sum + utf8ByteLength(message.content), 0)
  while (retainedBytes > COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES) {
    const removed = messages[0]
    messages = messages.slice(1)
    retainedBytes -= removed === undefined ? 0 : utf8ByteLength(removed.content)
  }
  return {
    messages,
    availability: {
      status: malformedCount === 0 ? "available" : "partial",
      sourceCount: sources.length,
      retainedCount: messages.length,
      malformedCount,
      truncated: contentTruncated || eligible.length > messages.length,
    },
  }
}

export function captureCompletionContinuationInput(
  options: CaptureCompletionContinuationInputOptions,
): CompletionContinuationInputSnapshot {
  const synchronous = (options.now ?? Date.now)()
  const todos = captureTodos(options.todos)
  const transcript = captureTranscript(options.transcript)
  const diffInput = options.diff?.input === null || options.diff === null
    ? null
    : { files: options.diff.input.files.map((file) => ({ ...file })) }
  const diffAvailability = options.diff?.availability
    ?? { status: "unavailable" as const, reason: "no_event" as const }
  return {
    input: { todos: todos.items, transcript: transcript.messages, diff: diffInput, boulder: null },
    inputDigests: {
      todoStatus: buildCompletionContinuationTodoStatusDigest(todos.items),
      transcript: transcript.messages.length === 0 ? null : digest(transcript.messages.map(({ role, content }) => ({ role, content }))),
      diff: options.diff?.digest ?? null,
      boulder: null,
    },
    availability: { todos: todos.availability, transcript: transcript.availability, diff: diffAvailability, boulder: null },
    capturedAt: {
      synchronous,
      diffObservedAt: options.diff?.observedAt ?? null,
      diffReadAt: options.diff?.readAt ?? null,
      boulder: null,
    },
  }
}

export function finalizeCompletionContinuationInput(
  snapshot: CompletionContinuationInputSnapshot,
  boulder: CompletionContinuationBoulderSnapshot,
): CompletionContinuationInputSnapshot {
  return {
    input: { ...snapshot.input, boulder: boulder.input },
    inputDigests: { ...snapshot.inputDigests, boulder: boulder.digest },
    availability: { ...snapshot.availability, boulder: boulder.availability },
    capturedAt: { ...snapshot.capturedAt, boulder: boulder.capturedAt },
  }
}
