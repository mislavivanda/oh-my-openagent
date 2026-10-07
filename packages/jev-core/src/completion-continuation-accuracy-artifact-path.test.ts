import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV,
  COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_RELATIVE_PATH,
  resolveCompletionContinuationAccuracyArtifactPath,
} from "./completion-continuation-accuracy-artifact-path"

const REPO = "/repo"
const TMP = "/scratch"

describe("completion-continuation accuracy artifact path", () => {
  test("#given no opt-in #when the path resolves #then it stays outside the repository", () => {
    for (const evidenceOptIn of [undefined, "", "0", "true", "yes"]) {
      const path = resolveCompletionContinuationAccuracyArtifactPath({ cwd: REPO, tmpDir: TMP, pid: 4242, evidenceOptIn })
      expect(path.startsWith(`${TMP}/`)).toBeTrue()
      expect(path.startsWith(`${REPO}/`)).toBeFalse()
      expect(path).not.toContain(".omo/evidence")
    }
  })

  test("#given no opt-in #when two processes resolve the path #then they do not collide", () => {
    const first = resolveCompletionContinuationAccuracyArtifactPath({ cwd: REPO, tmpDir: TMP, pid: 11, evidenceOptIn: undefined })
    const second = resolveCompletionContinuationAccuracyArtifactPath({ cwd: REPO, tmpDir: TMP, pid: 12, evidenceOptIn: undefined })
    expect(first).not.toBe(second)
  })

  test("#given the explicit opt-in #when the path resolves #then it points at the committed evidence artifact", () => {
    const path = resolveCompletionContinuationAccuracyArtifactPath({ cwd: REPO, tmpDir: TMP, pid: 7, evidenceOptIn: "1" })
    expect(path).toBe(join(REPO, COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_RELATIVE_PATH))
    expect(COMPLETION_CONTINUATION_ACCURACY_EVIDENCE_ENV).toBe("JEV_W2_ACCURACY_EVIDENCE")
  })
})
