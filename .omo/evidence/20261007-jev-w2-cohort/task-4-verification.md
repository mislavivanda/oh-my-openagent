# todo 4 - fix the self-dirtying evidence write and the zero-headroom budgets

## WHAT WAS TESTED

Two defects, each driven on the real surface that exhibits them.

DEFECT 1. `packages/jev-core/src/completion-continuation-accuracy.test.ts` wrote its mock
artifact into `.omo/evidence/20260930-jev-w2/task-7-accuracy-result.json`, a committed and
tracked file. Driving surface: a plain `bun test packages/jev-core` run plus
`git status --porcelain` on that exact path, before and after the fix.

DEFECT 2. `packages/omo-opencode/src/features/jev/completion-continuation-runtime-effects.test.ts`
asserted `activeHandles <= 73` and `inFlightMax <= 8` as literals, while the live measurements
were exactly 73 and 8. Driving surface: the runtime-effects suite itself, plus a deliberate
perturbation of one derivation term to prove the new assertion still bites.

## WHAT WAS OBSERVED

### DEFECT 1

Before (`task-4-defect1-before.txt`): the tracked artifact is clean (`matching_lines=0`), a
single `bun test packages/jev-core` run exits 0, and `git status --porcelain` on that path then
returns `matching_lines=1` with a 5-insertion 5-deletion diff. The run rewrote the retained
version-1 measurement with a version-2 one.

After (`task-4-defect1-after.txt`): the same run exits 0 and the same `git status --porcelain`
returns `matching_lines=0`. The suite log now reports where the artifact went:

    accuracy artifact=/tmp/jev-w2-accuracy/task-7-accuracy-result.3612509.json evidenceOptIn=unset

`git status --porcelain -- .omo/evidence/` filtered of peer todo-3's in-flight `task-19-*` files
is also empty (`matching_lines=0`, `grep` exit 1), so the run writes nothing anywhere under the
committed evidence tree.

The fix is a new injected resolver,
`packages/jev-core/src/completion-continuation-accuracy-artifact-path.ts`. By default it returns
a per-process scratch path under the OS temp dir; only `JEV_W2_ACCURACY_EVIDENCE=1` routes it
back onto the committed evidence path. `task-4-defect1-optin.txt` evaluates both branches
directly and shows the opt-in still resolves to the committed artifact, with the committed file
left clean. The real-API artifact paths (`REAL_ARTIFACT_PATH`, `REAL_ARTIFACT_V1_PATH`) are not
touched by this change, so a deliberate `JEV_W2_REAL_API=1` re-arm still writes exactly where
the evidence expects. Both retained historical artifacts are intact and tracked; nothing was
deleted or rewritten.

Three new given/when/then tests in
`packages/jev-core/src/completion-continuation-accuracy-artifact-path.test.ts` lock the
behavior: the default never lands inside the repository for any non-`"1"` env value, two pids do
not collide, and the opt-in equals the committed evidence path.

### DEFECT 2

The budget is now derived instead of hardcoded:

    ACTIVE_HANDLE_BUDGET = SINK_FLUSH_INTERVAL_HANDLES (1)
                         + DEFAULT_COMPLETION_CONTINUATION_OUTCOME_MAX_RECORDS_PER_SESSION (64)
                         + MAX_INFLIGHT (8)

`MAX_INFLIGHT` is now exported from `completion-continuation-runtime-fixture.ts`, which is the
same constant the stress config feeds to `wires.completion_continuation.max_inflight`, so the
in-flight assertion and the handle budget both track the real bound. The derivation is written
out in a block comment at the assertion site and echoed at runtime
(`task-4-defect2-runtime-effects.txt`):

    w2_active_timer_handles_budget=73 derivation=1_sink_interval+64_outcome_windows+8_inflight_backend_timeouts
    w2_active_timer_handles<=73 actual=73
    in_flight_max<=8 actual=8

The derived value equals 73 today, which is the pre-change literal. The cap was not widened and
no slack was introduced; `inFlightMax` stays bounded by `MAX_INFLIGHT = 8`.

Bite proof (`task-4-defect2-bite.txt`): setting `SINK_FLUSH_INTERVAL_HANDLES` to 0 makes the
derived budget 72 and the suite fails with `Expected: <= 72 / Received: 73`, exit 1. Reverting
restores exit 0. The assertion is therefore tight, not vacuous. Unref removal still fails
through the suite's own perturbations: `ANTI_VACUITY_UNREF_HANDLE=FAIL_DETECTED W2 handle unref
audit failed: missing_or_duplicate=1` and `ANTI_VACUITY_UNREF_CHILD=FAIL_DETECTED timed_out=true`.

### Gates

| gate | command | result |
| --- | --- | --- |
| jev-core suite | `bun test packages/jev-core` | exit 0, 237 pass 0 fail, 22 files |
| runtime effects | `bun test .../completion-continuation-runtime-effects.test.ts` | exit 0, 3 pass 0 fail |
| W2 inertness | `bun test .../completion-continuation-inert.test.ts` | exit 0, 2 pass 0 fail, file unmodified |
| root typecheck | `bun run typecheck` | exit 0 |
| root build | `bun run build` | exit 0, `build: all steps completed` |
| fast gate | `bun run test:fast` | exit 0, 799 pass 0 fail, 93 files |
| file sizes | per-file loop | 0 files above 250 lines |
| no-excuse scan | 8 banned patterns | 0 matching lines each |
| harness neutrality | `grep -rnw Stop packages/jev-core/src` + guard test | 0 matching lines, 3 pass |

`test:fast` observed 799 against the 795 baseline. Three of the four added tests are this todo's
new artifact-path tests; the remaining one comes from a peer todo landing concurrently in the
same shared worktree.

All four W2 inertness anti-vacuity probes fired unchanged
(`ANTI_VACUITY_PROMPT_BYTE`, `ANTI_VACUITY_COUNTDOWN_DELAY`, `ANTI_VACUITY_SIDE_EFFECT_ORDER`,
`ANTI_VACUITY_W2_OWNED_INJECTION`, plus `ANTI_VACUITY_PART_A_REVERT=PASS`), and the inert test
file itself is byte-unmodified by this todo.

## WHY IT IS ENOUGH

Defect 1's proof is an exact before/after on the single file that was being clobbered, driven by
the same command a developer or CI runs, with the dirty-line count going 1 to 0. The opt-in
branch and the untouched real-API paths are shown explicitly, so the escape hatch the evidence
workflow needs still exists. Three unit tests keep the default from regressing silently.

Defect 2's proof is not just that the suite passes. The derived budget is printed with its
derivation, so a reviewer can check the arithmetic without reading the implementation, and the
perturbation run shows the assertion fails the moment the derived number drops below the real
measurement. Because the budget now reads the same constants the runtime uses, a future change
to `maxRecordsPerSession` or `max_inflight` recomputes the ceiling instead of silently breaking
or silently loosening it.

Residual risk: the handle count still depends on the stress loop emitting one retention timer
per retained outcome window and one timeout per in-flight decision. If a future observer adds a
third timer family, the derived sum will be short by that family's count and the test will fail
loudly, which is the intended behavior; the comment at the assertion site names each term so the
fix is to add the new term rather than to raise a literal.

## WHAT WAS OMITTED

No real API call was made. `JEV_W2_REAL_API` and `JEV_W2_REAL_API_REARM` stayed unset for every
command recorded here, confirmed by the suite logging `real-api baseline skipped
realApiRequested=false`. No credentials, tokens, environment dumps or `.env` contents appear in
any artifact. The `test:fast` and inert logs contain the full W2 gauntlet traces that the suite
prints by design; they carry no secrets. Peer-owned paths (`script/jev-w2-report*.ts`,
`.omo/evidence/20260930-jev-w2/task-19-*`, `completion-continuation-questions.ts`, the jev-core
label fixture modules) were neither edited nor staged.
