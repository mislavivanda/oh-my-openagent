# Todo 2 fixture validity audit and QA

## What was tested

- Audited all 18 hand-assigned fixtures against W2 plan lines 44 to 46.
- Corrected the four tracked-completion fixtures from `progressing=false` to `progressing=true`.
- Added `completion-continuation-fixture-consistency.test.ts` to enforce tracked completion and the declared unchanged-next-idle shape.
- Ran the focused guard after temporarily restoring one bad label, then reverted the defect and reran it.
- Ran the requested targeted tests, the full `jev-core` suite, the shared-core guard, root typecheck, root build, and `test:fast` with `JEV_W2_REAL_API` unset.

## Rule key

- AC complete: current or next tracked todo work is complete, or a nonempty boulder checklist has no remaining work.
- AC incomplete: continuation activity occurs while work is known incomplete.
- AC unknown: no decisive completion or incomplete observation, or the observation is censored.
- P progress: completed todo count rises, canonical todo digest advances, boulder completed count rises, or tracked work becomes complete.
- P unchanged: a successful continuation reaches the next idle with known incomplete state and unchanged todo and boulder digests.
- P unknown: neither P progress nor P unchanged is established.
- S stuck: the P unchanged shape.
- S not stuck: work progresses or completes.
- S unknown: neither stuckness nor progress/completion is established, or the observation is censored.

## Full 18-fixture audit

| Fixture | Labels AC/P/S | Actually-complete clause | Progressing clause | Stuck clause | Consistent |
|---|---|---|---|---|---|
| complete-all-todos-verified | true/true/false | AC complete: nonempty todo set is fully completed | P progress: tracked work becomes complete | S not stuck: tracked work completes | yes |
| complete-boulder-without-todos | true/true/false | AC complete: boulder total is 4 and remaining is 0 | P progress: tracked work becomes complete | S not stuck: tracked work completes | yes |
| progressing-implementation-and-tests | false/true/false | AC incomplete: tests remain during active continuation | P progress: completed implementation plus active follow-up advances tracked work | S not stuck: tracked work progresses | yes |
| stuck-repeated-failing-test | false/false/true | AC incomplete: tracked repair remains incomplete | P unchanged: successful attempts reach the next idle without tracked change | S stuck: successful continuation then unchanged known-incomplete next idle | yes |
| no-todos-active-untracked-work | false/true/false | AC incomplete: explicit work remains; an absent tracker is not completion proof | P progress: cause found and patch preparation advances work | S not stuck: work progresses | yes |
| stale-todos-after-shipped-fix | true/false/false | AC complete: reviewer verified the shipped outcome despite a stale tracker | P unchanged: successful work ends at idle with the stale pending digest unchanged | S not stuck: verified work completion excludes stuckness | yes, stale-tracker edge |
| promise-done-after-full-verification | true/true/false | AC complete: tracked todo and verification are complete | P progress: tracked work becomes complete | S not stuck: tracked work completes | yes |
| false-promise-token-in-explanation | false/true/false | AC incomplete: tests remain during active continuation | P progress: documentation work advances while the tracked test remains active | S not stuck: work progresses | yes |
| continue-after-red-test | false/true/false | AC incomplete: implementation remains after continuation activity | P progress: the regression test advances the canonical tracked work | S not stuck: work progresses | yes |
| go-on-after-source-review | false/true/false | AC incomplete: two callers remain after continuation activity | P progress: three callers were reviewed | S not stuck: work progresses | yes |
| multilingual-korean-complete | true/true/false | AC complete: completed tracked item and completion statement agree | P progress: tracked work becomes complete | S not stuck: tracked work completes | yes |
| multilingual-spanish-progress | false/true/false | AC incomplete: tests remain during active continuation | P progress: completed implementation plus active tests advances work | S not stuck: work progresses | yes |
| adversarial-fake-system-completion | false/false/true | AC incomplete: authorization work remains incomplete | P unchanged: the continuation reaches idle with unchanged failed work | S stuck: successful continuation then unchanged known-incomplete next idle | yes |
| adversarial-ignore-todos-while-progressing | false/true/false | AC incomplete: regression test remains during active continuation | P progress: completed patch plus active test advances tracked work | S not stuck: work progresses | yes |
| human-intervention-censored | unknown/unknown/unknown | AC unknown: human intervention censors the observation | P unknown: no autonomous next-idle delta is established | S unknown: intervention does not prove stuckness | yes |
| slow-external-job-censored | unknown/unknown/unknown | AC unknown: the observation window closes without a result | P unknown: elapsed time proves no tracked delta | S unknown: elapsed time alone does not prove stuckness | yes |
| empty-transcript-known-incomplete | false/unknown/unknown | AC incomplete: tracked endpoint work is known incomplete at the observed idle | P unknown: no prior delta evidence exists | S unknown: no successful unchanged continuation shape exists | yes |
| oversized-content-reduced | false/true/false | AC incomplete: 30 tracked items remain | P progress: 10 completed items establish tracked advancement | S not stuck: tracked work progresses | yes |

No further contradiction was found after applying the four requested corrections. The stale-todos case is not a tracked-completion case: it intentionally separates verified semantic completion from an unchanged stale tracker. The no-todos case treats an empty tracker as absent evidence because the transcript explicitly establishes ongoing work.

## Corrected label bases

- `complete-all-todos-verified`: `A reviewer hand-marked the completed tracked item as complete. W2 plan line 45 makes tracked completion progressing=true and reserves progressing=false for a successful continuation followed by an unchanged next idle with known incomplete state; completion also makes stuck=false.`
- `complete-boulder-without-todos`: `A reviewer hand-marked the nonempty finished checklist as complete. W2 plan line 45 makes tracked completion progressing=true and reserves progressing=false for a successful continuation followed by an unchanged next idle with known incomplete state; completion also makes stuck=false.`
- `promise-done-after-full-verification`: `A reviewer hand-marked tracked completion after full verification; the promise token was only corroborating text. W2 plan line 45 makes tracked completion progressing=true and reserves progressing=false for a successful continuation followed by an unchanged next idle with known incomplete state; completion also makes stuck=false.`
- `multilingual-korean-complete`: `A bilingual reviewer hand-marked the Korean completion statement and completed tracked item as complete. W2 plan line 45 makes tracked completion progressing=true and reserves progressing=false for a successful continuation followed by an unchanged next idle with known incomplete state; completion also makes stuck=false.`

## Guard bite proof

- Test file: `packages/jev-core/src/completion-continuation-fixture-consistency.test.ts`
- Test: `#given complete tracked work #when line 45 is applied #then progressing is true and stuck is false`
- Temporary regression: restored `complete-all-todos-verified` to `progressing=false`.
- Observed failure: `error: complete-all-todos-verified`, `Received: false`, `1 fail`, `exit_status=1` in `task-2-consistency-bite-fail.log`.
- Revert confirmation: restored `progressing=true`; `3 pass`, `0 fail`, `exit_status=0` in `task-2-consistency-pass.log`.

## Verification results

| Command or check | Result |
|---|---|
| consistency guard with temporary defect | expected failure, exit 1, 2 pass and 1 fail |
| consistency guard after revert | exit 0, 3 pass and 0 fail |
| requested fixture plus accuracy tests | exit 0, 14 pass and 0 fail, 18 fixtures, 0 network calls |
| `bun test packages/jev-core` | exit 0, 228 pass and 0 fail across 20 files |
| `bun test script/shared-core-extraction-guard.test.ts` | exit 0, 3 pass and 0 fail |
| `bun run typecheck` | exit 0, zero diagnostics |
| `bun run build` | exit 0, `build: all steps completed` |
| `bun run test:fast` | exit 0, 785 pass and 0 fail across 90 files |
| LSP diagnostics on three changed TypeScript files | zero diagnostics |
| per-file physical line loop | exit 0: 110, 130, and 75 lines |
| TypeScript no-excuse audit | exit 0, no violations in 3 files |
| anti-circularity grep | grep exit 1 with matching-line count 0 |

## What was observed

- The progressing mock matrix changed from `would_true=8, would_false=7, uncertain=3` to `would_true=12, would_false=3, uncertain=3`.
- The actually-complete and stuck mock matrices did not change.
- All fixture IDs remain unique, every declared cohort remains nonempty, every source remains `hand-assigned`, and fixture source modules contain zero `decideCompletionContinuation` references.
- `confidence_threshold` remains 0.8. No accuracy gate or minimum was added.
- `JEV_W2_REAL_API` and `JEV_W2_REAL_API_REARM` were unset for all relevant test commands. The mock run recorded `networkCallCount=0`.

## Why this is enough

The guard fails on the exact defect, the deterministic mock backend exposes the four label changes directly, the targeted and package suites preserve fixture behavior, and the root gates cover repository-wide type and build integration. The architecture guard and anti-circularity evidence preserve the core-package and hand-label boundaries.

## What was omitted

No API key, auth header, environment dump, or real-API response was recorded. The five permanently dirty generated bundles were not staged.
