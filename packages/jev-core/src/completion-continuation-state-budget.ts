import type {
  CompletionContinuationState,
  CompletionContinuationStateBuildResult,
  CompletionContinuationTodoItem,
} from "./completion-continuation-state"

export const COMPLETION_CONTINUATION_MAX_STATE_BYTES = 24_576
export const COMPLETION_CONTINUATION_TODO_ITEM_LIMIT = 32
export const COMPLETION_CONTINUATION_TODO_CONTENT_MAX_BYTES = 256
export const COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_LIMIT = 8
export const COMPLETION_CONTINUATION_TRANSCRIPT_MESSAGE_MAX_BYTES = 1_500
export const COMPLETION_CONTINUATION_TRANSCRIPT_MAX_BYTES = 12_000
export const COMPLETION_CONTINUATION_DIFF_PATH_LIMIT = 32
export const COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES = 256
export const COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES = 4_096
export const COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES = 256

const textEncoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

export function truncateUtf8(value: string, maxBytes: number): {
  readonly value: string
  readonly truncated: boolean
} {
  if (utf8ByteLength(value) <= maxBytes) return { value, truncated: false }

  let bytes = 0
  let result = ""
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint)
    if (bytes + codePointBytes > maxBytes) break
    result += codePoint
    bytes += codePointBytes
  }
  return { value: result, truncated: true }
}

function serializedBytes(state: CompletionContinuationState): number {
  return utf8ByteLength(JSON.stringify(state))
}

function withTruncation(
  state: CompletionContinuationState,
  key: keyof CompletionContinuationState["inputTruncations"],
): CompletionContinuationState {
  return {
    ...state,
    inputTruncations: { ...state.inputTruncations, [key]: true },
  }
}

function truncateLastTodoContent(
  items: readonly CompletionContinuationTodoItem[],
  bytesToRemove: number,
): readonly CompletionContinuationTodoItem[] | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.content.length === 0) continue
    const targetBytes = Math.max(0, utf8ByteLength(item.content) - Math.max(1, bytesToRemove))
    const content = truncateUtf8(item.content, targetBytes).value
    return items.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, content } : candidate,
    )
  }
  return null
}

export function applyCompletionContinuationStateBudget(
  initialState: CompletionContinuationState,
): CompletionContinuationStateBuildResult {
  const preReductionBytes = serializedBytes(initialState)
  let state = initialState

  if (preReductionBytes > COMPLETION_CONTINUATION_MAX_STATE_BYTES) {
    state = withTruncation(state, "state")
  }

  while (serializedBytes(state) > COMPLETION_CONTINUATION_MAX_STATE_BYTES && (state.diff?.paths.length ?? 0) > 0) {
    state = withTruncation({
      ...state,
      diff: state.diff === null ? null : { ...state.diff, paths: state.diff.paths.slice(0, -1) },
    }, "diffPaths")
  }

  while (serializedBytes(state) > COMPLETION_CONTINUATION_MAX_STATE_BYTES && state.transcript.messages.length > 0) {
    state = withTruncation({
      ...state,
      transcript: { messages: state.transcript.messages.slice(1) },
    }, "transcriptMessages")
  }

  let currentBytes = serializedBytes(state)
  while (currentBytes > COMPLETION_CONTINUATION_MAX_STATE_BYTES) {
    const items = truncateLastTodoContent(
      state.todo.items,
      currentBytes - COMPLETION_CONTINUATION_MAX_STATE_BYTES,
    )
    if (items === null) break
    state = withTruncation({ ...state, todo: { ...state.todo, items } }, "todoContent")
    currentBytes = serializedBytes(state)
  }

  while (serializedBytes(state) > COMPLETION_CONTINUATION_MAX_STATE_BYTES && state.todo.items.length > 0) {
    state = withTruncation({
      ...state,
      todo: { ...state.todo, items: state.todo.items.slice(0, -1) },
    }, "todoItems")
  }

  const serialized = JSON.stringify(state)
  return { state, serialized, serializedBytes: utf8ByteLength(serialized), preReductionBytes }
}
