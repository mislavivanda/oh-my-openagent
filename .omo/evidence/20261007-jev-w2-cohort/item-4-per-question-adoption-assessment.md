# Item 4: per-question adoption assessment

Scope: decide, per question, whether the W2 completion-continuation signal is trustworthy enough to
be consumed by a downstream decision. This is an evidence-quality verdict only. W2 stays observe-only
and default-off; nothing here proposes an apply path.

All numbers below are recomputed from the two retained real-API artifacts, not restated from memory.
Banding was cross-checked against each artifact's own `thresholdLabels` field: 0 mismatches across
all 54 question-fixture pairs, so the recomputation is faithful.

Sources:
- v1: `.omo/evidence/20260930-jev-w2/task-18-real-api-result.json` (questionVersion 1)
- v2: `.omo/evidence/20260930-jev-w2-validity/task-7-real-api-result-v2.json` (questionVersion 2)

Threshold in force: `confidence_threshold = 0.8`. `would_true` at p >= 0.80, `would_false` at
p <= 0.20, `uncertain` otherwise. Unchanged throughout.

## The metric that decides adoption

Raw correctness over all known-label fixtures conflates two very different failures: answering wrong,
and declining to answer. For a signal that something downstream may consume, those are not
equivalent. A confident wrong answer corrupts a decision. An abstention merely fails to help.

So the assessment separates:

- **Precision**: of the answers that cleared the confidence bar, how many were right.
- **Recall**: of the known-label fixtures, how many got a confident and correct answer.
- **Abstention**: how often the question declined to commit.

## Results

| Question | Known | Confident | Correct | Confidently wrong | Abstained | Precision | Recall | Evidence status |
|---|---|---|---|---|---|---|---|---|
| `actually_complete` | 16 | 15 | 15 | 0 | 1 | 100% | 94% | VALID measurement |
| `stuck` | 15 | 9 | 9 | 0 | 6 | 100% | 60% | VALID measurement |
| `progressing` (v2 labels) | 15 | 7 | 6 | 1 | 8 | 86% | 40% | SUPERSEDED |
| `progressing` (v3 labels) | 9 | 6 | 6 | 0 | 3 | 100% | 67% | DIAGNOSTIC ONLY |

Question-text stability across v2 and v3, which determines whether a v2 number still measures the
shipping question:

| Question | Bytes | sha256 prefix | Status |
|---|---|---|---|
| `actually_complete` | 416 | `071debc6939e5a35` | byte-identical, v2 numbers still valid |
| `stuck` | 1550 | `fccb99d69acfeaa2` | byte-identical, v2 numbers still valid |
| `progressing` | 1495 to 1735 | changed | v2 numbers no longer measure the shipping text |

## The headline finding

**Every confident answer in the entire paid run is correct, once the corrected labels are applied.**

Across all three questions there was exactly one confidently wrong answer in the v2 run:
`no-todos-active-untracked-work`, where the model returned `progressing` p=0.13 (`would_false`)
against a label of `true`. Under the item 6 disambiguation that fixture is now labelled `unknown`,
because an ongoing untracked-work idle exhibits no observable transition. The label was wrong, not
the model.

So the item 6 rule change removed the only confident error in the paid corpus. That is independent
corroboration that the ambiguity was real and that the transition reading is the correct one.

## Per-question verdicts

### `actually_complete`: ADOPT

The only question with measurement-grade evidence on the text that actually ships. 15 of 16
known-label fixtures answered confidently and correctly, one abstention
(`stale-todos-after-shipped-fix`, p=0.59), zero confident errors. Stable across both paid runs at
15/16, and its text is byte-identical between v1, v2 and v3, so both runs measure the same question.

It abstains rarely, so it is useful as well as safe. This is the one question where the evidence
supports letting something downstream consume the answer.

### `stuck`: HOLD, safe but low-yield

Perfect precision: 9 confident answers, 9 correct, zero wrong. Text byte-identical across versions,
so the number is a real measurement of the shipping question.

The problem is yield. It abstains on 6 of 15 known-label fixtures, a 40% abstention rate, so it
answers less than two thirds of the time. Its maximum confidence also fell from 0.96 in v1 to 0.85 in
v2, meaning it sits closer to the bar than it used to and small prompt drift could push more answers
into the uncertain band.

Safe to consume when it speaks. Not dependable enough to build coverage on. Hold until a run shows
the abstention rate improving rather than the ceiling eroding.

### `progressing`: HOLD, not measured

No verdict is available, because the model has never been asked the v3 question. Item 6 rewrote the
criterion (1495 to 1735 bytes) and bumped `COMPLETION_CONTINUATION_QUESTION_VERSION` from 2 to 3, so
both paid runs measured text that no longer ships.

The diagnostic row above re-scores the retained v2 probabilities against the v3 labels. It is
encouraging: precision rises from 86% to 100% and the lone confident error disappears. But it is not
a measurement, because the model produced those probabilities while reading the v2 question. It
bounds how much of the apparent weakness was label churn rather than model failure; it cannot
substitute for a fresh run.

What the diagnostic does establish is that the pessimistic 6/15 figure was substantially an artifact
of labels that have since been corrected. Of the 9 fixtures that remain known-label under v3, the
model got 6 confidently right and abstained on the other 3
(`false-promise-token-in-explanation` 0.34, `continue-after-red-test` 0.53,
`go-on-after-source-review` 0.46). None of those is an error.

## What would unblock `progressing`

One paid run of 18 calls against the v3 question text. For reference the v2 run cost 18 calls,
35457 input and 1008 output tokens, 2737 ms wall clock. The v3 progressing text is about 240 bytes
longer per call, so expect roughly 37k input tokens.

The paid budget is fully spent at 18 of 18 twice and is protected by a persistent on-disk guard
requiring `JEV_W2_REAL_API_REARM=1`. That run was deliberately not made here, because no authorization
for further spend exists. The gap is reported rather than filled.

## What these numbers are not

The cohort measurement in todo 6 reported mock-backend agreement on dogfood records: 21/27 for
`actually_complete`, 7/27 for `progressing`, 20/27 for `stuck` on the autonomous cohort. Those
numbers exercise the end-to-end plumbing against a mock model. They say nothing about model quality
and are deliberately not mixed into the table above.

Fixture count is 18, of which 9 to 16 carry a known label depending on the question. Every conclusion
here rests on that sample size and should be read accordingly.
