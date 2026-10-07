import { join } from "node:path"

/**
 * The retained version-1 mock measurement. It is committed and tracked, so only a
 * deliberate opt-in run may overwrite it.
 */
export const COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_RELATIVE_PATH =
  ".omo/evidence/20260930-jev-w2/task-7-accuracy-result.json"

/** Set to "1" to route the mock accuracy artifact back onto the committed evidence path. */
export const COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV = "JEV_W2_ACCURACY_EVIDENCE"

export type CompletionContinuationAccuracyArtifactLocation = {
  readonly cwd: string
  readonly tmpDir: string
  readonly pid: number
  readonly evidenceOptIn: string | undefined
}

/**
 * A normal suite run must leave the repository untouched, so the artifact lands in a
 * per-process scratch file under the OS temp dir unless the caller explicitly opts in.
 * Every input is injected; this module reads no environment of its own.
 */
export function resolveCompletionContinuationAccuracyArtifactPath(
  location: CompletionContinuationAccuracyArtifactLocation,
): string {
  if (location.evidenceOptIn === "1") {
    return join(location.cwd, COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_RELATIVE_PATH)
  }
  return join(location.tmpDir, "jev-w2-accuracy", `task-7-accuracy-result.${location.pid}.json`)
}
