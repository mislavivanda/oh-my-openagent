import { createHash } from "node:crypto"
import {
  COMPLETION_CONTINUATION_DIFF_PATH_LIMIT,
  COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES,
  COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES,
  truncateUtf8,
  utf8ByteLength,
  type CompletionContinuationDiffInputFile,
  type CompletionContinuationStateInput,
} from "@oh-my-opencode/jev-core"

export const DEFAULT_COMPLETION_CONTINUATION_DIFF_MAX_SESSIONS = 256

export type CompletionContinuationObservedEvent = {
  readonly type: string
  readonly properties?: unknown
}

export type CompletionContinuationDiffAvailability =
  | { readonly status: "available"; readonly reason: null }
  | { readonly status: "unavailable"; readonly reason: "no_event" | "malformed_event" }

export type CompletionContinuationDiffSnapshot = {
  readonly input: CompletionContinuationStateInput["diff"]
  readonly availability: CompletionContinuationDiffAvailability
  readonly observedAt: number | null
  readonly readAt: number
  readonly digest: string | null
  readonly sourceFileCount: number | null
  readonly retainedPathCount: number
  readonly pathsTruncated: boolean
}

export type CompletionContinuationDiffCacheInspection = {
  readonly sessionCount: number
  readonly evictions: number
  readonly malformedEvents: number
}

export type CompletionContinuationDiffCache = {
  observeEvent(event: CompletionContinuationObservedEvent): void
  getSnapshot(sessionID: string): CompletionContinuationDiffSnapshot
  deleteSession(sessionID: string): void
  inspect(): CompletionContinuationDiffCacheInspection
}

export type CompletionContinuationDiffCacheOptions = {
  readonly maxSessions?: number
  readonly now?: () => number
}

type DiffCacheEntry = Omit<CompletionContinuationDiffSnapshot, "readAt"> & {
  lastAccess: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function digest(files: readonly CompletionContinuationDiffInputFile[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`
}

function parseFiles(value: unknown): {
  readonly files: readonly CompletionContinuationDiffInputFile[]
  readonly retainedPathCount: number
  readonly pathsTruncated: boolean
} | null {
  if (!Array.isArray(value)) return null
  const sources: { readonly file: string; readonly additions: number; readonly deletions: number }[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return null
    const file = candidate["file"]
    const additions = candidate["additions"]
    const deletions = candidate["deletions"]
    if (typeof file !== "string" || file.length === 0) return null
    if (!isNonNegativeInteger(additions) || !isNonNegativeInteger(deletions)) return null
    sources.push({ file, additions, deletions })
  }

  let retainedBytes = 0
  let retainedPathCount = 0
  let pathsTruncated = false
  const files = sources.map((source) => {
    let path = ""
    if (
      retainedPathCount < COMPLETION_CONTINUATION_DIFF_PATH_LIMIT
      && retainedBytes < COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES
    ) {
      const remainingBytes = COMPLETION_CONTINUATION_DIFF_PATHS_MAX_BYTES - retainedBytes
      const bounded = truncateUtf8(
        source.file,
        Math.min(COMPLETION_CONTINUATION_DIFF_PATH_MAX_BYTES, remainingBytes),
      )
      path = bounded.value
      retainedBytes += utf8ByteLength(path)
      retainedPathCount += 1
      pathsTruncated ||= bounded.truncated
    } else {
      pathsTruncated = true
    }
    return { path, additions: source.additions, deletions: source.deletions }
  })
  return { files, retainedPathCount, pathsTruncated }
}

function positiveSessionLimit(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_COMPLETION_CONTINUATION_DIFF_MAX_SESSIONS
}

export function createCompletionContinuationDiffCache(
  options: CompletionContinuationDiffCacheOptions = {},
): CompletionContinuationDiffCache {
  const maxSessions = positiveSessionLimit(options.maxSessions)
  const now = options.now ?? Date.now
  const entries = new Map<string, DiffCacheEntry>()
  let accessClock = 0
  let evictions = 0
  let malformedEvents = 0

  function touch(entry: DiffCacheEntry): void {
    accessClock += 1
    entry.lastAccess = accessClock
  }

  function ensureCapacity(sessionID: string): void {
    if (entries.has(sessionID) || entries.size < maxSessions) return
    let victimID: string | undefined
    let victimAccess = Number.POSITIVE_INFINITY
    for (const [candidateID, candidate] of entries) {
      if (candidate.lastAccess < victimAccess) {
        victimID = candidateID
        victimAccess = candidate.lastAccess
      }
    }
    if (victimID !== undefined) {
      entries.delete(victimID)
      evictions += 1
    }
  }

  function store(sessionID: string, entry: Omit<DiffCacheEntry, "lastAccess">): void {
    ensureCapacity(sessionID)
    const next = { ...entry, lastAccess: 0 }
    touch(next)
    entries.set(sessionID, next)
  }

  function storeMalformed(sessionID: string): void {
    store(sessionID, {
      input: null,
      availability: { status: "unavailable", reason: "malformed_event" },
      observedAt: now(),
      digest: null,
      sourceFileCount: null,
      retainedPathCount: 0,
      pathsTruncated: false,
    })
  }

  function observeEvent(event: CompletionContinuationObservedEvent): void {
    if (event.type !== "session.diff") return
    const properties = isRecord(event.properties) ? event.properties : null
    const sessionIDValue = properties?.["sessionID"]
    const sessionID = typeof sessionIDValue === "string" ? sessionIDValue.trim() : ""
    const parsed = parseFiles(properties?.["diff"])
    if (sessionID === "" || parsed === null) {
      malformedEvents += 1
      if (sessionID !== "") storeMalformed(sessionID)
      return
    }
    store(sessionID, {
      input: { files: parsed.files },
      availability: { status: "available", reason: null },
      observedAt: now(),
      digest: digest(parsed.files),
      sourceFileCount: parsed.files.length,
      retainedPathCount: parsed.retainedPathCount,
      pathsTruncated: parsed.pathsTruncated,
    })
  }

  function getSnapshot(sessionID: string): CompletionContinuationDiffSnapshot {
    const entry = entries.get(sessionID)
    if (entry === undefined) {
      return {
        input: null,
        availability: { status: "unavailable", reason: "no_event" },
        observedAt: null,
        readAt: now(),
        digest: null,
        sourceFileCount: null,
        retainedPathCount: 0,
        pathsTruncated: false,
      }
    }
    touch(entry)
    const { lastAccess: _lastAccess, ...snapshot } = entry
    return { ...snapshot, readAt: now() }
  }

  return {
    observeEvent,
    getSnapshot,
    deleteSession: (sessionID) => { entries.delete(sessionID) },
    inspect: () => ({ sessionCount: entries.size, evictions, malformedEvents }),
  }
}
