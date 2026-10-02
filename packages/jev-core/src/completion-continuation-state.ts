import { createHash } from "node:crypto"
import type {
  CompletionContinuationInputDigests,
  CompletionContinuationInputTruncations,
} from "./completion-continuation-record-types"
import { COMPLETION_CONTINUATION_QUESTION_KEYS } from "./completion-continuation-questions"
import type { CompletionContinuationPreviousState } from "./completion-continuation-previous-state"
import {
  COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATH_LIMIT,
  COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  COMPLETION_CONTINUATION_TODO_ITEM_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES,
  applyCompletionContinuationStateBudget,
  truncateUtf8,
  utf8ByteLength,
} from "./completion-continuation-state-budget"

export {
  COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATH_LIMIT,
  COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
  COMPLETION_CONTINUATION_MAX_STATE_BYTES,
  COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES,
  COMPLETION_CONTINUATION_TODO_ITEM_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT,
  COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES,
  truncateUtf8,
  utf8ByteLength,
} from "./completion-continuation-state-budget"

export type CompletionContinuationTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"

export type CompletionContinuationTodoInputItem = {
  readonly id: string
  readonly status: CompletionContinuationTodoStatus
  readonly content: string
}

export type CompletionContinuationTranscriptInputMessage = {
  readonly role: string
  readonly content: string
  readonly synthetic: boolean
}

export type CompletionContinuationDiffInputFile = {
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

export type CompletionContinuationBoulderInput = {
  readonly total: number
  readonly completed: number
  readonly remaining: number
  readonly nextTaskTitle: string | null
}

export type CompletionContinuationStateInput = {
  readonly todos: readonly CompletionContinuationTodoInputItem[]
  readonly transcript: readonly CompletionContinuationTranscriptInputMessage[]
  readonly diff: { readonly files: readonly CompletionContinuationDiffInputFile[] } | null
  readonly boulder: CompletionContinuationBoulderInput | null
  readonly previous?: CompletionContinuationPreviousState
}

export type CompletionContinuationTodoItem = CompletionContinuationTodoInputItem

export type CompletionContinuationState = {
  readonly questionKeys: typeof COMPLETION_CONTINUATION_QUESTION_KEYS
  readonly previous: CompletionContinuationPreviousState
  readonly todo: {
    readonly total: number
    readonly pending: number
    readonly inProgress: number
    readonly completed: number
    readonly cancelled: number
    readonly statusDigest: string
    readonly items: readonly CompletionContinuationTodoItem[]
  }
  readonly transcript: {
    readonly messages: readonly {
      readonly role: "user" | "assistant"
      readonly content: string
    }[]
  }
  readonly diff: {
    readonly fileCount: number
    readonly additions: number
    readonly deletions: number
    readonly paths: readonly string[]
  } | null
  readonly boulder: CompletionContinuationBoulderInput | null
  readonly inputDigests: CompletionContinuationInputDigests
  readonly inputTruncations: CompletionContinuationInputTruncations
}

export type CompletionContinuationStateBuildResult = {
  readonly state: CompletionContinuationState
  readonly serialized: string
  readonly serializedBytes: number
  readonly preReductionBytes: number
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function compareTodoStatus(
  left: CompletionContinuationTodoInputItem,
  right: CompletionContinuationTodoInputItem,
): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1
  if (left.status === right.status) return 0
  return left.status < right.status ? -1 : 1
}

export function buildCompletionContinuationTodoStatusDigest(
  todos: readonly CompletionContinuationTodoInputItem[],
): string {
  const canonical = todos.toSorted(compareTodoStatus).map(({ id, status }) => [id, status])
  return digest(canonical)
}

function countTodoStatuses(todos: readonly CompletionContinuationTodoInputItem[]) {
  const counts = { pending: 0, inProgress: 0, completed: 0, cancelled: 0 }
  for (const todo of todos) {
    switch (todo.status) {
      case "pending": counts.pending += 1; break
      case "in_progress": counts.inProgress += 1; break
      case "completed": counts.completed += 1; break
      case "cancelled": counts.cancelled += 1; break
      default: throw new TypeError(`Unexpected todo status: ${todo.status satisfies never}`)
    }
  }
  return counts
}

function buildTranscript(input: CompletionContinuationStateInput["transcript"]) {
  const eligible = input.filter((message) =>
    !message.synthetic && (message.role === "user" || message.role === "assistant"),
  )
  let contentTruncated = false
  let messages = eligible.slice(-COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT).map((message) => {
    const content = truncateUtf8(message.content, COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES)
    contentTruncated ||= content.truncated
    const role: "user" | "assistant" = message.role === "user" ? "user" : "assistant"
    return { role, content: content.value }
  })
  let totalBytes = messages.reduce((sum, message) => sum + utf8ByteLength(message.content), 0)
  while (totalBytes > COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES) {
    const removed = messages[0]
    messages = messages.slice(1)
    totalBytes -= removed === undefined ? 0 : utf8ByteLength(removed.content)
  }
  return {
    eligible,
    messages,
    messagesTruncated: eligible.length > messages.length,
    contentTruncated,
  }
}

function buildDiff(diff: CompletionContinuationStateInput["diff"]) {
  if (diff === null) return { state: null, pathsTruncated: false, contentTruncated: false }
  let contentTruncated = false
  let paths = diff.files.slice(0, COMPLETION_CONTINUATION_DIFF_PATH_LIMIT).map((file) => {
    const path = truncateUtf8(file.path, COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES)
    contentTruncated ||= path.truncated
    return path.value
  })
  let totalBytes = paths.reduce((sum, path) => sum + utf8ByteLength(path), 0)
  while (totalBytes > COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES) {
    const removed = paths.at(-1)
    paths = paths.slice(0, -1)
    totalBytes -= removed === undefined ? 0 : utf8ByteLength(removed)
  }
  return {
    state: {
      fileCount: diff.files.length,
      additions: diff.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: diff.files.reduce((sum, file) => sum + file.deletions, 0),
      paths,
    },
    pathsTruncated: diff.files.length > paths.length,
    contentTruncated,
  }
}

export function buildCompletionContinuationState(
  input: CompletionContinuationStateInput,
): CompletionContinuationStateBuildResult {
  const statusDigest = buildCompletionContinuationTodoStatusDigest(input.todos)
  const todoItems = input.todos.slice(0, COMPLETION_CONTINUATION_TODO_ITEM_LIMIT).map((todo) => ({
    ...todo,
    content: truncateUtf8(todo.content, COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES).value,
  }))
  const transcript = buildTranscript(input.transcript)
  const diff = buildDiff(input.diff)
  const boulderTitle = input.boulder?.nextTaskTitle === null || input.boulder === null
    ? null
    : truncateUtf8(input.boulder.nextTaskTitle, COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES)
  const state: CompletionContinuationState = {
    questionKeys: COMPLETION_CONTINUATION_QUESTION_KEYS,
    previous: input.previous ?? { available: false, reason: "first_idle" },
    todo: { total: input.todos.length, ...countTodoStatuses(input.todos), statusDigest, items: todoItems },
    transcript: { messages: transcript.messages },
    diff: diff.state,
    boulder: input.boulder === null ? null : { ...input.boulder, nextTaskTitle: boulderTitle?.value ?? null },
    inputDigests: {
      todoStatus: statusDigest,
      transcript: transcript.eligible.length === 0 ? null : digest(transcript.eligible.map(({ role, content }) => ({ role, content }))),
      diff: input.diff === null ? null : digest(input.diff.files),
      boulder: input.boulder === null ? null : digest(input.boulder),
    },
    inputTruncations: {
      todoItems: input.todos.length > todoItems.length,
      todoContent: input.todos.slice(0, COMPLETION_CONTINUATION_TODO_ITEM_LIMIT).some((todo, index) => todo.content !== todoItems[index]?.content),
      transcriptMessages: transcript.messagesTruncated,
      transcriptContent: transcript.contentTruncated,
      diffPaths: diff.pathsTruncated,
      diffContent: diff.contentTruncated,
      boulderContent: boulderTitle?.truncated ?? false,
      state: false,
    },
  }
  return applyCompletionContinuationStateBudget(state)
}
