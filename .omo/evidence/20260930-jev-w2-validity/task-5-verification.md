# Todo 5 previous-idle adapter wiring verification

## What was tested

- Added `getLatestPreviousSnapshot(sessionID)` to the in-memory outcome store and drove it through the real adapter dispatch controller.
- Added failing-first coverage for highest-ordinal selection, first-idle absence, a second idle carrying the first idle's digests and counts, and missing or throwing accessor degradation.
- Added predecessor inputs to every fixture in the `progressing` and `stuck` cohorts while retaining an explicit first-idle fixture.
- Ran all requested JEV, continuation-hook, inertness, runtime-neutrality, typecheck, build, fast-suite, LSP, line-limit, and empty-proof checks.
- Started OpenCode 1.18.32 as an isolated `--pure` server, checked `/global/health` and `/event`, and compared the real database session count before and after.

## What was observed

### Behavior

- Failing-first adapter test: exit 1 with 1 pass and 3 fail. The failures were the absent accessor, absent second-idle predecessor, and unread throwing accessor.
- Focused adapter test after implementation: exit 0 with 4 pass, 0 fail, and 9 expect calls.
- The accessor returns the highest-ordinal retained record's immutable input snapshot plus `continuationDispatched`. It does not call `touch`, mutate counters, close records, perform I/O, schedule work, or await anything.
- `continuationDispatched` comes from the predecessor record's `continuationActivity`, which is set only after observed post-idle assistant or tool activity calls `markContinuationActivity`.
- A missing predecessor, missing accessor, or throwing accessor produces `{ available: false, reason: "first_idle" }` and continues the synchronous idle path without throwing.
- The second-idle test observed the first idle's todo digest, boulder digest, todo total/completed counts, boulder total/completed/remaining counts, and `continuationDispatched: true` in the model state.

### Fixtures

- Added available predecessors to `progressing-implementation-and-tests`, `stuck-repeated-failing-test`, `no-todos-active-untracked-work`, `false-promise-token-in-explanation`, `continue-after-red-test`, `go-on-after-source-review`, `multilingual-spanish-progress`, `adversarial-fake-system-completion`, `adversarial-ignore-todos-while-progressing`, and `oversized-content-reduced`.
- `complete-all-todos-verified` deliberately carries `{ available: false, reason: "first_idle" }`.
- No `label` line changed. The empty-proof artifact records grep exit 1 and zero changed label lines.
- The untouched consistency test passed inside `bun test packages/jev-core`.
- Fixture anti-circularity grep exited 1 with zero `decideCompletionContinuation` references.

### Required verification

| Command | Result |
|---|---|
| `bun test packages/omo-opencode/src/features/jev` | exit 0, 147 pass, 0 fail, 616 expect calls across 20 files |
| `bun test packages/jev-core` | exit 0, 234 pass, 0 fail, 753 expect calls across 21 files, mock path reported `networkCalls=0` and question version 2 |
| `bun test packages/omo-opencode/src/hooks/todo-continuation-enforcer packages/omo-opencode/src/plugin/hooks/create-continuation-hooks.test.ts` | exit 0, 147 pass, 0 fail, 355 expect calls across 21 files |
| unchanged inertness command | exit 0, 5 pass, 0 fail, 36 expect calls across 2 files; Part A trace count remained 16 in success, sync-throw, rejection, and timeout modes |
| Bun runtime adapter audit | exit 0, 1 pass, 0 fail |
| OpenCode coupling audit | exit 0, 2 pass, 0 fail |
| LSP diagnostics on 12 changed TypeScript files | zero diagnostics after the one test-only state type was corrected |
| `bun run typecheck` | exit 0 |
| `bun run build` | exit 0, `build: all steps completed` |
| `bun run test:fast` | exit 0, 795 pass, 0 fail, 2439 expect calls across 92 files |
| per-file physical line loop | exit 0; all 12 files at most 250 lines, maximum 249 |
| isolated OpenCode QA | exit 0; healthy 1.18.32 server, one `server.connected`, real session count 504 before and after, server process gone |

The inertness log's `FAIL_DETECTED` lines are deliberate anti-vacuity mutations. Each is followed by its expected revert proof, and the suite exits 0.

### Static checks

- Literal completion question-version references: grep exit 1, matching-line count 0. Test data imports `COMPLETION_CONTINUATION_QUESTION_VERSION`.
- `confidence_threshold` changed lines: grep exit 1, matching-line count 0. The configured value remains 0.8.
- Added forbidden TypeScript patterns: grep exit 1, matching-line count 0.
- The optional no-excuse helper reported seven inherited `catch-without-narrowing` sites in `completion-continuation-dispatch.ts`. None was added or changed by todo 5, and the changed-line forbidden scan was clean. They were not refactored because this todo must preserve the crash-isolated observer behavior and call ordering.

## Why it is enough

The focused integration test proves the model receives the real predecessor record rather than a fabricated block. Store tests prove highest-ordinal and side-effect-free reads. The full feature and core suites cover consumers and fixture consistency. The unchanged inertness proof preserves live gauntlet bytes and effect budgets, while the isolated real OpenCode probe proves server and event plumbing without touching the host database. Root typecheck, build, and fast tests cover repository integration.

## What was omitted

No paid or real Jev API path was enabled. `JEV_W2_REAL_API` and `JEV_W2_REAL_API_REARM` stayed unset, and the mock harness reported zero network calls. No API key, token, auth header, environment dump, provider response, or private credential was captured. The five permanently dirty generated bundles were not included in todo 5 staging.
