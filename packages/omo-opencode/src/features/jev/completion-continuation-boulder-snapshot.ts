import { createHash } from "node:crypto"
import {
  getPlanChecklist,
  readBoulderState,
  resolveBoulderPlanPath,
} from "@oh-my-opencode/boulder-state"
import {
  COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES,
  truncateUtf8,
  type CompletionContinuationBoulderInput,
} from "@oh-my-opencode/jev-core"

export type CompletionContinuationBoulderAvailability =
  | { readonly status: "available"; readonly reason: null }
  | {
    readonly status: "unavailable"
    readonly reason: "boulder_not_found" | "plan_path_unavailable" | "plan_checklist_unavailable"
  }

export type CompletionContinuationBoulderSnapshot = {
  readonly input: CompletionContinuationBoulderInput | null
  readonly availability: CompletionContinuationBoulderAvailability
  readonly capturedAt: number
  readonly digest: string | null
  readonly titleTruncated: boolean
}

export type CompletionContinuationBoulderSnapshotTask = {
  cancel(): void
}

export type ScheduleCompletionContinuationBoulderSnapshotInput = {
  readonly directory: string
  readonly onSnapshot: (snapshot: CompletionContinuationBoulderSnapshot) => void
  readonly now?: () => number
}

function digest(input: CompletionContinuationBoulderInput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`
}

function unavailable(
  reason: Extract<CompletionContinuationBoulderAvailability, { status: "unavailable" }>["reason"],
  capturedAt: number,
): CompletionContinuationBoulderSnapshot {
  return {
    input: null,
    availability: { status: "unavailable", reason },
    capturedAt,
    digest: null,
    titleTruncated: false,
  }
}

function captureBoulderSnapshot(
  directory: string,
  now: () => number,
): CompletionContinuationBoulderSnapshot {
  const capturedAt = now()
  const state = readBoulderState(directory)
  if (state === null) return unavailable("boulder_not_found", capturedAt)
  if (typeof state.active_plan !== "string" || state.active_plan.trim() === "") {
    return unavailable("plan_path_unavailable", capturedAt)
  }
  const planPath = resolveBoulderPlanPath(directory, state)
  const checklist = getPlanChecklist(planPath)
  if (checklist.total === 0) return unavailable("plan_checklist_unavailable", capturedAt)

  const title = checklist.nextTaskLabel === null
    ? { value: null, truncated: false }
    : truncateUtf8(checklist.nextTaskLabel, COMPLETION_CONTINUATION_BOULDER_TITLE_MAX_BYTES)
  const input: CompletionContinuationBoulderInput = {
    total: checklist.total,
    completed: checklist.completed,
    remaining: checklist.remaining,
    nextTaskTitle: title.value,
  }
  return {
    input,
    availability: { status: "available", reason: null },
    capturedAt,
    digest: digest(input),
    titleTruncated: title.truncated,
  }
}

export function scheduleCompletionContinuationBoulderSnapshot(
  input: ScheduleCompletionContinuationBoulderSnapshotInput,
): CompletionContinuationBoulderSnapshotTask {
  let active = true
  const timer = setTimeout(() => {
    if (!active) return
    active = false
    input.onSnapshot(captureBoulderSnapshot(input.directory, input.now ?? Date.now))
  }, 0)
  timer.unref()
  return {
    cancel: () => {
      if (!active) return
      active = false
      clearTimeout(timer)
    },
  }
}
