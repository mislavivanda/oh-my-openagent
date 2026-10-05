# Task 7 - authorized question-version-2 real-API re-measure

Branch `jev/w2-validity`, worktree `/home/opencode/projects/oh-my-openagent-jev-w2v`, stacked on `jev/w2`.
The user explicitly authorized exactly one paid run for this todo. It spent 18 of 18 budgeted calls.

## WHAT WAS TESTED

**The hypothesis.** Question version 1 asked `progressing` and `stuck` as delta questions while sending a
single snapshot with no prior values. Todos 3 to 5 added a bounded `previous` block and sharpened the
criteria to name its fields, and todo 4 bumped `COMPLETION_CONTINUATION_QUESTION_VERSION` to 2. The
prediction under test: supplying the previous block should let `progressing` exceed 0.80 on
genuinely-progressing fixtures. The falsifier: `progressing` still never clears 0.80 on those fixtures.

**The paid surface.**

```
JEV_W2_REAL_API=1 JEV_W2_REAL_API_REARM=1 \
  bun test packages/jev-core/src/completion-continuation-accuracy.test.ts
```

One invocation, driving `runRealCompletionContinuationBaseline()` against the live TypeSafe systemOne
endpoint, 18 fixtures, one three-question call each, SDK retries disabled
(`packages/jev-core/src/real-backend.ts` `retry: { maxRetries: 0 }`), per-call timeout 15000 ms.

**The unpaid work that came first, in order.**

1. Mock and dry-run paths confirmed clean with no real-api env: 8 pass, 0 fail,
   `accuracy mode=mock fixtures=18 calls=18 networkCalls=0 questionVersion=2`.
2. The local-fake-endpoint orchestration suite confirmed clean: 5 pass, 0 fail
   (`completion-continuation-real-run.test.ts`).
3. A full-scale counter and ceiling probe against a local fake endpoint
   (`task-7-preflight-counter-ceiling.txt`). This is the required proof that the counter is a real
   counter before any money moved.
4. The persistent guard proven live: with `JEV_W2_REAL_API=1`, the key present, and
   `JEV_W2_REAL_API_REARM` unset, the run reported `newSpend=0` and reused the retained version-1
   baseline instead of spending.
5. Root `bun run typecheck` and `bun run build` exit 0; `bun test packages/jev-core` 234 pass, 0 fail.

**The one source change.** `packages/jev-core/src/completion-continuation-accuracy.test.ts` now writes the
paid artifact to a version-derived path,
`.omo/evidence/20260930-jev-w2-validity/task-7-real-api-result-v${COMPLETION_CONTINUATION_QUESTION_VERSION}.json`,
and the persistent guard reads the current-version artifact first and falls back to the version-1 path.
The version-1 artifact is therefore never written, and both versions stay spend-protected. Full diff in
`task-7-gates.txt`.

## WHAT WAS OBSERVED

**Run facts.** status `complete`, mode `real`, questionVersion `2`, fixtureCount 18, completedFixtures 18,
callCeiling 18, reserved callCount 18, observed `networkCallCount` 18, per-call request counts all 1.
Requested model `jev-latest`; **resolved model `jev-1.13.0`** on every one of the 18 calls. Input tokens
35457, output tokens 1008, total 36465 (version 1 was 25029 and 1008). Per-call latency min 119 ms,
median 147 ms, max 245 ms; whole sequence wall clock 2737 ms. `confidence_threshold` untouched at 0.8.

**Pre-flight counter and ceiling proof.** Against the local fake endpoint: 18 fixtures produced client
counter 18 and server-observed 18, equal; 19 entries at ceiling 18 threw `PaidCallCeilingError`
`ceiling=18 nextOrdinal=19` with the server still at 18, so the ceiling **aborts before call 19 rather
than silently capping**; a forced extra attempt moved a counter 18 to 19. The probe lives in `/tmp` and
nothing it created was committed.

**Primary result, label-independent.** `progressing` across all 18 fixtures:

| run | min | median | max | count at p >= 0.80 |
| --- | --- | --- | --- | --- |
| v1 | 0.04 | 0.38 | 0.77 | 0 of 18 |
| v2 | 0.06 | 0.37 | **0.86** | **4 of 18** |

**The prediction is CONFIRMED.** Four genuinely-progressing fixtures cleared the 0.80 bar that version 1
never reached on any fixture: `progressing-implementation-and-tests` 0.86,
`adversarial-ignore-todos-while-progressing` 0.86, `multilingual-spanish-progress` 0.85,
`oversized-content-reduced` 0.82.

**Honest limits on that confirmation, stated up front.**

- 9 of the 13 genuinely-progressing fixtures are still short of the bar. The ceiling moved; it did not
  disappear.
- Every fixture that cleared 0.80 carries a `previous` block, and no first-idle fixture cleared it. Among
  genuinely-progressing fixtures the mean `progressing` change is +0.08 with a previous block and -0.26
  without one.
- The four completion-class fixtures fell hard, from the 0.68 to 0.77 band down to 0.33 to 0.40. Those are
  labelled `progressing: true` only by the W2 plan line-45 rule, so the model now disagrees with the rule
  rather than with the evidence. That is a labelling-rule question for a later todo, not a ceiling question.
- Version 2 introduces one confidently-wrong `progressing` answer: `no-todos-active-untracked-work`,
  label `true`, predicted `would_false` at 0.13. Version 1 produced zero confidently-wrong `progressing`
  answers against its own labels. The question traded 3 fewer uncertain answers for 1 confident error.
  `actually_complete` and `stuck` remain at zero confidently-wrong.
- `stuck` max fell from 0.96 to 0.85 and its median from 0.28 to 0.20.

**The two W1-worst-class continuation fixtures.** `continue-after-red-test` `progressing` 0.38 to 0.53
(+0.15); `go-on-after-source-review` 0.42 to 0.46 (+0.04). Both rose, both carry a previous block, and
**neither cleared 0.80**, so both stay in the uncertain band.

**Previous-block coverage.** 11 of 18 fixtures carry a previous block; 7 of 18 exercise the explicit
first-idle path.

**Version-2 confusion matrices, with the non-comparability caveat.** `actually_complete` 15 of 16 correct,
1 uncertain. `progressing` 6 of 15 correct, 11 uncertain. `stuck` 9 of 15 correct, 8 uncertain. These are
scored against the todo-2 **corrected** labels while the version-1 matrices were scored against the old
labels, so **a matrix delta between the runs is not a like-for-like improvement** and none is computed
anywhere in this evidence. Only the raw probability distribution is comparable.

**Post-run guard.** With the version-2 artifact now on disk and `JEV_W2_REAL_API_REARM` unset, a repeat run
reported `newSpend=0` and pointed at the version-2 artifact (`task-7-guard-after.txt`).

Full recomputation from both retained artifacts, including the per-fixture version-1 to version-2 table for
all 18 fixtures and all three questions, is in `task-7-real-api-v2.txt`.

## WHY IT IS ENOUGH

The primary claim is a probability-distribution comparison recomputed from the two retained artifacts
rather than restated from a console log, and it is immune to the five label corrections that landed in
todo 2. The version-1 artifact was verified byte-identical afterward
(sha256 `ed19fa3b6cf4e4e5f765540ad4420de4c9e3bd6c57e797ac7888c0d1bf58a9b2`, unchanged in `git status`), so
the comparison baseline is primary evidence and survives for future runs. Spend control was proven before
spending, not assumed: the counter was watched moving, the ceiling was watched aborting at ordinal 19, and
the persistent guard was watched refusing to spend. The run then reported exactly 18 reserved calls and 18
HTTP requests with one request per fixture, so the budget was met exactly, not exceeded and not undercounted.
No assertion in the harness checks a minimum score, so a falsifying result would have been reported with the
same machinery.

Residual risk: a single sample per fixture at one point in time against a floating alias that resolved to
`jev-1.13.0`. The confirmation is one run, not a distribution over runs, and no re-run is budgeted. The
label-rule disagreement on the completion-class fixtures is unresolved and is the strongest candidate for
the next investigation.

## WHAT WAS OMITTED

No API key, auth header, environment dump, or raw SDK debug log appears in any file committed for this todo.
The credential is read by the runtime from a gitignored env file and the harness never prints it; `.env` and
`.env.local` were never staged. Raw request and response bodies are not retained anywhere in the pipeline.
The local fake endpoint used a literal placeholder string as its credential, and that probe's output is
summarized rather than dumped. The secret scan over the whole evidence directory is recorded in
`task-7-secret-scan.txt`. No apply path was added, `confidence_threshold` was not touched, no accuracy
assertion was introduced, and no confusion-matrix delta is presented across the label change.
