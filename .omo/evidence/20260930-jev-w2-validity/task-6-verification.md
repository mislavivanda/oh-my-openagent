# Todo 6 verification: re-prove inertness, re-measure on the mock path

Branch `jev/w2-validity` stacked on `jev/w2`. Worktree
`/home/opencode/projects/oh-my-openagent-jev-w2v`. No production source was edited by this todo:
todo 6 is measurement and gates only.

## WHAT WAS TESTED

### Part A: is the W2 observer still inert after the wire input changed

The parent W2 branch's whole safety claim is that the observer adds no behavior to the live
continuation gauntlet. This plan changed the wire input, so the claim was re-established rather
than assumed.

- `bun test packages/omo-opencode/src/hooks/todo-continuation-enforcer/completion-continuation-inert.test.ts packages/omo-opencode/src/features/jev/completion-continuation-runtime-effects.test.ts`
  drives todo 15's Part A byte-identity trace over four dispatch modes plus the Part B runtime
  budget measurements. Intended to prove the live gauntlet's observable effects are byte-identical
  and the observer leaks no handle, heap, or child process.
- The same run carries six anti-vacuity probes. Each deliberately breaks one invariant and asserts
  the proof catches it. Intended to prove the guarantee is not vacuous.
- `bun test packages/omo-opencode/src/hooks/todo-continuation-enforcer packages/omo-opencode/src/plugin/hooks/create-continuation-hooks.test.ts`
  covers the surrounding continuation hook wiring.

Artifact: `task-6-inertness.txt`.

### Part B: mock-path re-measure

- `bun run /tmp/jev-w2v-t6/mock-after.ts` runs `runAccuracy()` from
  `packages/jev-core/src/completion-continuation-accuracy-harness.ts` on the mock backend with
  `JEV_W2_REAL_API` unset. The script is the todo-1 before script with only header text and output
  path changed, so before and after are produced by the same code path.
- Intended to prove the five label corrections and the previous-block wiring are carried through,
  and to report the per-question confusion matrix, the band counts at threshold 0.8, and the
  probability distribution.

Artifacts: `task-6-mock-after.txt`, `task-6-mock-before-after.txt`.

### Part C: full gate sweep

- `bun run typecheck`, `bun run build`, `bun run test:fast`.
- `env -u OPENCODE_SERVER_PASSWORD bun test --timeout 20000`, compared against the parent branch's
  recorded baseline on duration-stripped identities.
- Per-file 250-line loop over `git diff --name-only jev/w2...HEAD`, one `wc -l` per file.
- `bun test packages/omo-opencode/src/shared/opencode-adapter-bun-runtime-audit.test.ts packages/omo-opencode/src/shared/opencode-coupling-audit.test.ts`.
- Threshold and accuracy-gate audit over the branch diff.

Artifacts: `task-6-gates.txt`, `task-6-full-suite-identities.txt`, `task-6-file-lines.log`,
`task-6-threshold-audit.log`, `task-6-no-real-api.log`.

## WHAT WAS OBSERVED

### Part A observed

Exit 0, 5 pass, 0 fail, 36 expect() calls, 2 files. Four dispatch modes each produced
`TRACE_COUNT=16` with an identical ordered trace, and in every mode the W2-owned effects were
removed from the live path.

All six anti-vacuity probes still fire. None stopped firing, so there is no hard stop to report:

```
ANTI_VACUITY_UNREF_HANDLE=FAIL_DETECTED W2 handle unref audit failed: missing_or_duplicate=1
ANTI_VACUITY_UNREF_CHILD=FAIL_DETECTED timed_out=true pid=3196337 elapsed_ms=754.47
ANTI_VACUITY_PROMPT_BYTE=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_COUNTDOWN_DELAY=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_SIDE_EFFECT_ORDER=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_W2_OWNED_INJECTION=FAIL_DETECTED W2-owned effect leaked into Part A: backend_call
```

Part B runtime numbers against their budgets:

| Measurement | Observed | Budget | Verdict |
| --- | --- | --- | --- |
| active W2 timer handles | 73 | at most 73 | within budget, at the cap |
| unref-missing count | 0 | exactly 0 | within budget |
| in-flight max | 8 | at most 8 | within budget, at the cap |
| persisted drop count | 992 | equals attempted_excess 992 | exact match, no silent loss |
| heap delta bytes | 2987792 | under 16777216 | within budget, 17.8 percent of cap |
| child exit ms | 100.03 | under 2000 | within budget, 5.0 percent of cap |
| sync seam p99 ms | 0.099854 | under 1 | within budget |
| idle handler added p99 ms | 0.012262 | under 5 | within budget |

The wider continuation suite: exit 0, 147 pass, 0 fail, 21 files.

### Part B observed

`mode=mock`, `status=complete`, `fixtureCount=18`, `callCount=18`, `networkCallCount=0`,
`resolvedModel=mock`, `questionVersion=2`, `confidenceThreshold=0.8`, `byteCaps.state=24576`,
`fixturesCarryingPreviousBlock=11 of 18`.

Before and after, read mechanically from both artifacts:

| Question | Metric | Before | After | Delta |
| --- | --- | --- | --- | --- |
| actually_complete | would_true / would_false / uncertain | 5 / 11 / 2 | 5 / 11 / 2 | unchanged |
| actually_complete | distribution min / median / max | 0.05 / 0.05 / 0.95 | 0.05 / 0.05 / 0.95 | unchanged |
| actually_complete | matrix false / true / unknown totals | 11 / 5 / 2 | 11 / 5 / 2 | unchanged |
| progressing | would_true / would_false / uncertain | 8 / 7 / 3 | 13 / 2 / 3 | changed |
| progressing | distribution min / median / max | 0.05 / 0.50 / 0.95 | 0.05 / 0.95 / 0.95 | median changed |
| progressing | matrix false / true / unknown totals | 7 / 8 / 3 | 2 / 13 / 3 | changed |
| stuck | would_true / would_false / uncertain | 2 / 13 / 3 | 2 / 13 / 3 | unchanged |
| stuck | distribution min / median / max | 0.05 / 0.05 / 0.95 | 0.05 / 0.05 / 0.95 | unchanged |
| stuck | matrix false / true / unknown totals | 13 / 2 / 3 | 13 / 2 / 3 | unchanged |

Exactly 5 of 54 question-by-fixture rows moved, all on `progressing`, all `false` to `true`:
`complete-all-todos-verified`, `complete-boulder-without-todos`, `multilingual-korean-complete`,
`promise-done-after-full-verification`, `stale-todos-after-shipped-fix`. Question version moved
from 1 to 2.

### Part C observed

| Gate | Command | Exit | Observed |
| --- | --- | --- | --- |
| typecheck | `bun run typecheck` | 0 | zero diagnostics across root, script, and 28 packages |
| build | `bun run build` | 0 | final line `build: all steps completed` |
| fast suite | `bun run test:fast` | 0 | 795 pass, 0 fail, 92 files; 780 at todo 1, a rise of 15 |
| full suite | `env -u OPENCODE_SERVER_PASSWORD bun test --timeout 20000` | 1 | 13121 pass, 3 skip, 7 fail, 1723 files, 124.73s |
| identities | `diff` of normalized sets | 0 | baseline 7, observed 7, diff 0 lines |
| line limit | per-file `wc -l` loop | n/a | 19 source files checked, 0 violations |
| audits | adapter Bun runtime plus coupling | 0 | 3 pass, 0 fail |
| threshold | grep audit over the branch diff | n/a | 0.8 unchanged, 0 accuracy gates |

Nonzero exit on the full suite is expected: the recorded baseline itself carries 7 pre-existing
failures. The comparison is on duration-stripped identities, because bun's per-test durations are
non-deterministic. Observed durations are this run's own; no baseline duration was pasted onto
observed output.

Three committed evidence files exceed 250 lines (`task-2-build.log` 300, `task-2-stale-build.log`
300, `task-5-build.log` 298). All three are verbatim `bun run build` stdout landed by todos 2 and
5. They are captured tool output rather than authored code, and truncating them would destroy the
evidence they are. Todo 6 authors no file above 250 lines.

## WHY IT IS ENOUGH

Inertness is proved on two independent axes at once. The byte-identity trace shows the live
gauntlet's observable effects are unchanged across success, sync-throw, rejection, and timeout. The
runtime budgets show the observer leaks no handle, no unref, no heap, and no child process, every
number inside its budget. The six anti-vacuity probes show the proof still bites, so a regression
could not slip through silently. That is what makes re-running it meaningful rather than ceremonial
after the wire input changed.

The mock re-measure is attributable. The after script is the before script with only header text
and an output path changed, and the mock backend is a pure function of the hand label, so the only
thing that can move the numbers is the labels and the plumbing that carries them. Exactly the five
corrected fixtures moved, and `actually_complete` and `stuck` are unchanged in every single metric,
which is precisely the expected blast radius of a `progressing`-only label correction. Any wider
drift would have shown up as an extra changed row.

The gate sweep closes the holes `test:fast` cannot see. Root typecheck exercises the root tsconfig,
`build` exercises the real bundler, and the full suite runs the repo meta-audits. The full suite is
compared against the parent branch's own recorded baseline, so a single added failure anywhere in
13131 tests would appear as a nonempty identity diff. It did not.

### The limitation, stated plainly

The mock backend maps the label straight to a probability: `true` to 0.95, `false` to 0.05,
`unknown` to 0.50. It never reads the state, so it never reads the new `previous` block either. It
echoes labels rather than reasoning.

The mock path therefore **does** validate that the five label corrections are wired through and
that the consistency guard holds. It **cannot** show whether the `previous` block lifts the real
model's 0.77 `progressing` ceiling, because a backend that echoes labels has no ceiling to lift.

The `progressing` move from 8 `would_true` to 13 `would_true` is arithmetic from the corrected
labels. It is **not** evidence that the delta-input fix works. The root cause this plan identified,
that we ask a delta question while withholding the delta, remains unmeasured. Only a real-API run
can measure it, and that run is deliberately deferred to the blocked todo 7.

### Real-API reference and the falsifiable prediction

Read-only from `task-6-mock-before-after.txt`, itself derived from the retained W2 artifact:
`progressing` max 0.77 against the 0.80 bar with 14 of 18 uncertain and 2 of 15 correct; `stuck`
max 0.96 with 8 of 15 correct; `actually_complete` 15 of 16 correct.

The prediction, framed as an untested hypothesis: supplying the `previous` block should let
`progressing` exceed 0.80 on genuinely-progressing fixtures, where the version-1 run never exceeded
0.77 on any of the 18. It is falsified by a real-API run at question version 2 in which
`progressing` still never exceeds 0.80 on those fixtures, which would mean the delta-input theory is
wrong and the cause lies elsewhere. Status: untested.

## WHAT WAS OMITTED

- **The real-API re-measure is deliberately deferred and blocked on authorization.** It is todo 7 of
  this plan. Todo 18 of the parent plan spent its entire 18-call budget and a persistent on-disk
  guard now protects it, requiring `JEV_W2_REAL_API_REARM=1` to re-arm. Re-arming spends real money
  and is not authorized. Todo 6 made zero real API calls: `JEV_W2_REAL_API` stayed unset,
  `JEV_W2_REAL_API_REARM` was never set, the harness ran `mode=mock`, and `networkCallCount=0`
  with a counting fetch that throws on any outbound request. Proof in `task-6-no-real-api.log`.
  Consequence: the central hypothesis of this plan is still unmeasured.
- **No apply path was exercised.** The wire stays observe-only and default-off, so no live session
  behavior was driven through the observer's decisions.
- **No credential, token, auth header, or environment dump appears in any artifact.** A grep for
  key-shaped and auth-shaped strings across every todo-6 artifact exited 1 with 0 matching lines.
  `OPENCODE_SERVER_PASSWORD` is removed from the full-suite environment by the command itself and
  its value is never printed. `.env` and `.env.local` were neither read into an artifact nor staged.
- **Raw gate stdout is not reproduced in full.** The exact commands, exit statuses, and measured
  values are recorded instead. The raw full-suite log is 141 lines of mostly unrelated progress
  output; its 7 failure lines are reproduced verbatim in `task-6-full-suite-identities.txt`.
- **Three pre-existing over-250-line evidence logs were reported rather than rewritten.** Editing
  another todo's captured output to satisfy a line limit would falsify that evidence.
