# Todo 2 stale-tracker follow-up

## Semantic and mechanical ground truth

W2 plan lines 44 and 45 define the mechanical mapping used by the live outcome store. It compares current and next tracked snapshots, counts completed items, and checks canonical digests.

The fixture corpus has a different purpose. Its `groundTruthSource` is `hand-assigned`, and reviewers assign semantic truth for accuracy measurement from the bounded fixture evidence. A semantic label may agree with the mechanical mapping, or it may intentionally override stale, absent, adversarial, multilingual, or censored tracker evidence. Every question within one fixture must use one coherent basis. Mixing semantic completion with mechanical no-progress is invalid.

## Corrected fifth contradiction

Fixture: `stale-todos-after-shipped-fix`

Before:

`{ actuallyComplete: true, progressing: false, stuck: false }`

After:

`{ actuallyComplete: true, progressing: true, stuck: false }`

New label basis:

`A reviewer hand-marked the verified shipped outcome as semantically complete and progressing despite the explicitly stale todo snapshot. The accuracy fixture follows the shipped fix and passed production verification; the unchanged todo digest belongs to the live outcome store's mechanical mapping and does not govern this hand-assigned semantic label.`

## New consistency rule

The existing rule still derives tracked completion from snapshot shape. The new independent rule starts from the label:

```ts
const claimsCompletion = fixture.label.actuallyComplete === true
if (claimsCompletion) expect(fixture.label.progressing, fixture.id).not.toBeFalse()
```

Keying on `actuallyComplete` includes stale and untracked semantic-completion fixtures that do not have completed todo or boulder snapshots. It prevents a fixture from claiming semantic completion while claiming mechanical no-progress.

## Guard bite proof

Pre-fix run:

- command: `bun test packages/jev-core/src/completion-continuation-fixture-consistency.test.ts`
- result: exit 1, 3 pass, 1 fail
- named failure: `error: stale-todos-after-shipped-fix`
- assertion: `Received: false`
- artifact: `task-2-stale-consistency-bite-fail.log`

Post-fix run:

- same command
- result: exit 0, 4 pass, 0 fail, 55 assertions
- artifact: `task-2-stale-consistency-pass.log`

## Re-audit of all 18 fixtures

| Fixture | Final AC/P/S | Basis used for all labels | Semantic versus mechanical assessment | Mixed basis |
|---|---|---|---|---|
| complete-all-todos-verified | true/true/false | Semantic reviewer judgement from completed todo and verification | Semantic truth agrees with mechanical tracked completion | no |
| complete-boulder-without-todos | true/true/false | Semantic reviewer judgement from completed boulder and verification | Semantic truth agrees with mechanical boulder completion | no |
| progressing-implementation-and-tests | false/true/false | Semantic reviewer judgement from completed implementation and remaining tests | Tracker evidence corroborates semantic partial progress | no |
| stuck-repeated-failing-test | false/false/true | Semantic reviewer judgement from repeated unchanged attempts and idle | Semantic truth agrees with the mechanical unchanged-next-idle shape | no |
| no-todos-active-untracked-work | false/true/false | Semantic reviewer judgement from explicit ongoing work | Non-mechanical by construction; transcript truth overrides the empty tracker | no |
| stale-todos-after-shipped-fix | true/true/false | Semantic reviewer judgement from shipped fix and passed verification | Non-mechanical by construction; stale digest is excluded from all three labels | no after fix |
| promise-done-after-full-verification | true/true/false | Semantic reviewer judgement from tracked completion and verification | Promise text corroborates but does not determine truth | no |
| false-promise-token-in-explanation | false/true/false | Semantic reviewer judgement from context saying tests remain | Literal promise text is ignored as non-semantic data | no |
| continue-after-red-test | false/true/false | Semantic reviewer judgement from prior assistant context, red test, and remaining implementation | Transcript tail supplies the progress basis | no |
| go-on-after-source-review | false/true/false | Semantic reviewer judgement from three reviewed and two remaining callers | Transcript tail supplies the progress basis | no |
| multilingual-korean-complete | true/true/false | Semantic bilingual reviewer judgement | Completed tracker corroborates the Korean completion statement | no |
| multilingual-spanish-progress | false/true/false | Semantic bilingual reviewer judgement | Completed implementation and remaining tests are coherent partial progress | no |
| adversarial-fake-system-completion | false/false/true | Semantic reviewer judgement after ignoring fake system text | Remaining failed work agrees with mechanical stuck shape | no |
| adversarial-ignore-todos-while-progressing | false/true/false | Semantic reviewer judgement after ignoring embedded scoring text | Concrete patch and active test establish progress | no |
| human-intervention-censored | unknown/unknown/unknown | Semantic censoring because a human ended autonomous observation | No mechanical or semantic outcome is asserted | no |
| slow-external-job-censored | unknown/unknown/unknown | Semantic censoring because the window ended without a result | Elapsed time establishes none of the three labels | no |
| empty-transcript-known-incomplete | false/unknown/unknown | Semantic evidence-sufficiency judgement | Pending work establishes incompletion; missing history establishes neither progress nor stuckness | no |
| oversized-content-reduced | false/true/false | Semantic reviewer judgement before deterministic reduction | Ten completed and thirty remaining items establish partial progress | no |

No further mixed-basis contradiction was found. The two requested edge checks are coherent:

- `no-todos-active-untracked-work` uses transcript semantics for all three labels and does not treat the empty tracker as mechanical completion.
- `empty-transcript-known-incomplete` uses the pending task to establish semantic incompletion, while absent history leaves the delta questions unknown.

## Mock matrix shift

Additional stale-tracker correction:

- progressing `would_true`: 12 to 13
- progressing `would_false`: 3 to 2
- progressing `uncertain`: 3 to 3

Relative to the original todo-1 baseline:

- progressing `would_true`: 8 to 13
- progressing `would_false`: 7 to 2
- progressing `uncertain`: 3 to 3

The actually-complete and stuck matrices did not change. The mock run recorded 18 fixtures and zero network calls at confidence threshold 0.8.

## Verification

| Command or check | Result |
|---|---|
| sharpened consistency test before fixture fix | expected exit 1, 3 pass, 1 fail, named stale fixture |
| sharpened consistency test after fixture fix | exit 0, 4 pass, 0 fail, 55 assertions |
| focused consistency, fixture, and accuracy tests | exit 0, 18 pass, 0 fail, 124 assertions, 0 network calls |
| `bun test packages/jev-core` | exit 0, 229 pass, 0 fail across 20 files |
| `bun test script/shared-core-extraction-guard.test.ts` | exit 0, 3 pass, 0 fail |
| `bun run typecheck` | exit 0 |
| `bun run build` | exit 0, all steps completed |
| `bun run test:fast` | exit 0, 786 pass, 0 fail across 90 files |
| LSP diagnostics | zero diagnostics in both changed TypeScript files |
| per-file physical line loop | 110 and 88 lines, exit 0 |
| TypeScript no-excuse audit | no violations in 2 files, exit 0 |
| anti-circularity grep | grep exit 1, matching-line count 0 |

`JEV_W2_REAL_API` and `JEV_W2_REAL_API_REARM` were unset. No real API call was made. `confidence_threshold` remains 0.8. No accuracy threshold, minimum, or gate was added.

## What was omitted

No API key, auth header, environment dump, real-API response, `.env`, or `.env.local` content was recorded. The five ambient generated bundles were not staged.
