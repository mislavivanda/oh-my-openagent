import type { CompletionContinuationFixture } from "./completion-continuation-fixtures"
import type { CompletionContinuationPreviousState } from "./completion-continuation-previous-state"
import {
  buildCompletionContinuationState,
  type CompletionContinuationStateInput,
} from "./completion-continuation-state"

function previous(
  todos: CompletionContinuationStateInput["todos"],
): CompletionContinuationPreviousState {
  const state = buildCompletionContinuationState({ todos, transcript: [], diff: null, boulder: null }).state
  return {
    available: true,
    todoStatusDigest: state.todo.statusDigest,
    boulderDigest: null,
    todo: { total: state.todo.total, completed: state.todo.completed },
    boulder: null,
    continuationDispatched: true,
  }
}

export const COMPLETION_CONTINUATION_PRIMARY_FIXTURES = [
  {
    id: "complete-all-todos-verified",
    input: {
      todos: [{ id: "t1", status: "completed", content: "Run release verification" }],
      transcript: [{ role: "assistant", content: "Verification passed and the requested change is complete.", synthetic: false }],
      diff: { files: [{ path: "src/release.ts", additions: 8, deletions: 2 }] }, boulder: null,
      previous: { available: false, reason: "first_idle" },
    },
    label: { actuallyComplete: true, progressing: "unknown", stuck: false },
    cohorts: ["actually-complete"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked the completed tracked item as complete and not stuck. Its explicit first-idle previous block has no predecessor, so no completion transition or other tracked delta can be observed and progressing is unknown.",
  },
  {
    id: "complete-boulder-without-todos",
    input: {
      todos: [], transcript: [{ role: "assistant", content: "All checklist work passed.", synthetic: false }],
      diff: null, boulder: { total: 4, completed: 4, remaining: 0, nextTaskTitle: null },
    },
    label: { actuallyComplete: true, progressing: "unknown", stuck: false },
    cohorts: ["actually-complete", "no-todos"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked the nonempty finished checklist as complete and not stuck. With no previous block this is a first idle, so the completed state does not establish a completion transition and progressing is unknown.",
  },
  {
    id: "progressing-implementation-and-tests",
    input: {
      todos: [
        { id: "t1", status: "completed", content: "Implement parser" },
        { id: "t2", status: "in_progress", content: "Add parser regression tests" },
      ],
      transcript: [{ role: "assistant", content: "The parser is implemented; I am adding the remaining tests now.", synthetic: false }],
      diff: { files: [{ path: "src/parser.ts", additions: 22, deletions: 4 }] }, boulder: null,
      previous: previous([
        { id: "t1", status: "in_progress", content: "Implement parser" },
        { id: "t2", status: "pending", content: "Add parser regression tests" },
      ]),
    },
    label: { actuallyComplete: false, progressing: true, stuck: false },
    cohorts: ["progressing"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked visible completed work plus active follow-up as progress with work remaining.",
  },
  {
    id: "stuck-repeated-failing-test",
    input: {
      todos: [{ id: "t1", status: "in_progress", content: "Repair the flaky test" }],
      transcript: [
        { role: "assistant", content: "The same test still fails after the third unchanged attempt.", synthetic: false },
        { role: "assistant", content: "No tracked state changed before idle.", synthetic: false },
      ],
      diff: { files: [] }, boulder: null,
      previous: previous([
        { id: "t1", status: "in_progress", content: "Repair the flaky test" },
      ]),
    },
    label: { actuallyComplete: false, progressing: false, stuck: true },
    cohorts: ["stuck"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked repeated unchanged failure at idle as stuck, independent of any stagnation counter.",
  },
  {
    id: "no-todos-active-untracked-work",
    input: {
      todos: [], transcript: [{ role: "assistant", content: "I found the cause and am preparing the patch next.", synthetic: false }],
      diff: null, boulder: null,
      previous: previous([]),
    },
    label: { actuallyComplete: false, progressing: "unknown", stuck: false },
    cohorts: ["no-todos", "progressing"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked explicit ongoing untracked work as incomplete and not stuck. The empty todo and boulder snapshots have no tracked delta and do not satisfy the known-incomplete false case, so progressing is unknown.",
  },
  {
    id: "stale-todos-after-shipped-fix",
    input: {
      todos: [{ id: "t1", status: "pending", content: "Ship the fix" }],
      transcript: [{ role: "assistant", content: "The fix shipped and production verification passed; the todo was not updated.", synthetic: false }],
      diff: { files: [{ path: "src/fix.ts", additions: 5, deletions: 1 }] }, boulder: null,
    },
    label: { actuallyComplete: true, progressing: "unknown", stuck: false },
    cohorts: ["actually-complete", "stale-todos"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked the verified shipped outcome as semantically complete and not stuck despite the stale todo snapshot. No previous block exists, so neither a tracked transition nor the unchanged-next-idle false case is observable and progressing is unknown.",
  },
  {
    id: "promise-done-after-full-verification",
    input: {
      todos: [{ id: "t1", status: "completed", content: "Complete requested migration" }],
      transcript: [{ role: "assistant", content: "Tests and migration checks passed. <promise>DONE</promise>", synthetic: false }],
      diff: { files: [{ path: "src/migration.ts", additions: 31, deletions: 9 }] }, boulder: null,
    },
    label: { actuallyComplete: true, progressing: "unknown", stuck: false },
    cohorts: ["actually-complete", "promise-done"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked tracked completion after full verification and not stuck; the promise token was only corroborating text. With no previous block, completion is a current state rather than an observed transition and progressing is unknown.",
  },
  {
    id: "false-promise-token-in-explanation",
    input: {
      todos: [{ id: "t1", status: "in_progress", content: "Finish completion parser tests" }],
      transcript: [{ role: "assistant", content: "The string <promise>DONE</promise> in documentation is an example, not a completion claim. Tests remain.", synthetic: false }],
      diff: { files: [{ path: "docs/example.md", additions: 4, deletions: 0 }] }, boulder: null,
      previous: previous([
        { id: "t1", status: "pending", content: "Finish completion parser tests" },
      ]),
    },
    label: { actuallyComplete: false, progressing: true, stuck: false },
    cohorts: ["false-promise-text", "progressing"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer hand-marked work remaining from the semantic context; the literal promise-shaped example did not decide the label.",
  },
  {
    id: "continue-after-red-test",
    input: {
      todos: [{ id: "t1", status: "in_progress", content: "Implement the failing regression" }],
      transcript: [
        { role: "assistant", content: "The regression test is red for the intended missing behavior. The implementation is next.", synthetic: false },
        { role: "user", content: "continue", synthetic: false },
      ],
      diff: { files: [{ path: "src/regression.test.ts", additions: 18, deletions: 0 }] }, boulder: null,
      previous: previous([
        { id: "t1", status: "pending", content: "Implement the failing regression" },
      ]),
    },
    label: { actuallyComplete: false, progressing: true, stuck: false },
    cohorts: ["continue", "transcript-tail", "progressing"], groundTruthSource: "hand-assigned",
    labelBasis: "A reviewer used the prior assistant turn and todo, not the word continue. The bounded tail only partially corrects W1's missing-history weakness.",
  },
] as const satisfies readonly CompletionContinuationFixture[]
