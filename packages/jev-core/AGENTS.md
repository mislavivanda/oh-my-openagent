# jev-core — Jev decision backend (Core)

**Added:** Phase A (`jev/phase-a`), against release tag `v4.19.4`

## OVERVIEW

Jev is TypeSafe AI's "System One" model: it answers typed questions (Choice / Noul / Score) with calibrated probabilities in roughly 70-500 ms instead of generating text. This package wraps that idea behind one harness-neutral seam, `DecisionBackend`, so any omo harness can ask a typed question and get back either a validated answer or an explicit `unavailable` outcome.

It is a separate package for two reasons: the same primitives get reused across harnesses (OpenCode today, Codex and Senpi later), and `@typesafe-ai/sdk` is imported in exactly one production file here (`src/real-backend.ts`), so the SDK dependency has a single auditable boundary. Package: `@oh-my-opencode/jev-core`. Zero IO outside that one file, no `process.env` reads, no dynamic imports, every dependency injected.

## PUBLIC API (`src/index.ts` barrel)

| Module | Key exports |
|--------|-------------|
| `types.ts` | `export type *`: `ChoiceQuestion`, `NoulQuestion`, `ScoreQuestion`, `Question`, `Questions`, `ChoiceAnswer`, `NoulAnswer`, `ScoreAnswer`, `Answer`, `AnswerFor`, `JsonValue`, `DecisionState`, `DecisionRequest`, `DecisionUsage`, `DecisionUnavailableReason`, `DecisionOutcome`, `DecisionBackendKind`, `DecisionBackend` |
| `mock-backend.ts` | `createMockDecisionBackend(script, options?)`, `choiceAnswer(choice, confidence, options)`, type `MockDecisionScript` |
| `real-backend.ts` | `createRealDecisionBackend(deps)`, type `RealDecisionBackendDeps` |
| `llm-adapter-backend.ts` | `createLlmAdapterDecisionBackend()` — placeholder, always `unavailable` / `not_implemented` |
| `disabled-backend.ts` | `createDisabledDecisionBackend()` — always `unavailable` / `disabled` |
| `backend-selector.ts` | `selectDecisionBackend(config, deps?)`, types `DecisionBackendConfig`, `DecisionBackendDeps` |
| `model-error-triage.ts` | `decideModelErrorTriage(args)`, `buildModelErrorTriageState(input)`, `MODEL_ERROR_TRIAGE_QUESTIONS`, `MODEL_ERROR_TRIAGE_QUESTION_VERSION`, `MODEL_ERROR_MESSAGE_MAX_CHARS`, types `ModelErrorTriageChoice`, `ModelErrorTriageInput`, `ModelErrorTriageResult` |
| `model-error-triage-fixtures.ts` | `MODEL_ERROR_TRIAGE_FIXTURES`, `MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE`, types `ModelErrorTriageFixture`, `ModelErrorTriageFixtureSource` |
| `intent-routing.ts` | `decideIntentRouting(args)`, `buildIntentRoutingQuestions(vocab)`, `INTENT_ROUTING_QUESTION_VERSION`, `IntentRoutingVocabularyError`, types `IntentRoutingVocabulary`, `IntentRoutingVocabularyOption`, `IntentRoutingInput`, `IntentRoutingDecisionResult`, `IntentRoutingLabels`, `IntentRoutingThresholdLabel` |
| `intent-routing-record.ts` | `selectLatestCounterDeltasByProcess(entries)`, `INTENT_ROUTING_CONTINUATION_LEXICON`, types `IntentRoutingObservationRecord`, `IntentRoutingCounterDelta`, `IntentRoutingEntry`, `IntentRoutingCounters`, `IntentRoutingAnswers`, `IntentRoutingChoiceAnswer`, `IntentRoutingNoulAnswer`, `IntentRoutingObservedDelegation` |
| `intent-routing-record-validation.ts` | `validateIntentRoutingObservationRecord`, `validateIntentRoutingCounterDelta`, `validateIntentRoutingEntry` |
| `intent-routing-normalization.ts` | `normalizeObservedDelegation(args)`, `deriveRoute(observation)`, `derivePredictedRoute(answers)`, `INTENT_ROUTING_CATEGORY_VOCABULARY`, `INTENT_ROUTING_SUBAGENT_VOCABULARY`, types `ObservedDelegationArgs`, `NormalizedObservedDelegation`, `IntentRoutingRoute`, `DerivedRoute`, `RouteObservation` |
| `intent-routing-fixtures.ts` | `INTENT_ROUTING_FIXTURES`, `INTENT_ROUTING_FIXTURE_SOURCES`, types `IntentRoutingFixture`, `IntentRoutingFixtureLabel`, `IntentRoutingFixtureIntent`, `IntentRoutingFixtureSource` |

`answer-validation.ts` is deliberately NOT exported from the barrel. It is the single internal definition of "well-formed answer" shared by the mock and real backends, and both return the guarded original object so `answers` typechecks as `{ [K in keyof Q]: AnswerFor<Q[K]> }` with no cast.

## W1 INTENT-ROUTING MODULES

W1 predicts the delegation shape of a turn. It is OBSERVE-ONLY: nothing here alters harness
behavior, it only produces a record that can later be scored against what the turn actually
did. The five modules split along one axis, what is harness-neutral enough to live in a core
package.

| Module | Responsibility |
|--------|----------------|
| `intent-routing.ts` | The question set and the decision call. `buildIntentRoutingQuestions()` turns a caller-supplied vocabulary into four questions (`intent`, `category`, `subagent` as Choice, `ambiguous` as Noul). `decideIntentRouting()` runs them through a `DecisionBackend` and returns validated answers plus a `would_apply` / `would_fall_through` label per Choice question. The labels are advisory: they record what a threshold WOULD have decided, they gate nothing. |
| `intent-routing-record.ts` | The on-disk entry union. `IntentRoutingObservationRecord` is one sealed turn; `IntentRoutingCounterDelta` is a periodic per-process counter snapshot; `IntentRoutingEntry` is their union. `selectLatestCounterDeltasByProcess()` collapses many counter deltas down to the newest one per process so a reader never double-counts. `INTENT_ROUTING_CONTINUATION_LEXICON` marks turns that look like continuations rather than fresh intents. |
| `intent-routing-record-validation.ts` | The single reader-side gate. Deliberately NOT a Zod schema: the sink is append-only JSONL written by possibly-older processes, so a reader must tolerate a malformed line by skipping it, never by throwing. The three predicates are type guards, so a validated line typechecks without a cast. |
| `intent-routing-normalization.ts` | The comparison layer. Raw delegation arguments and raw model answers are not comparable until both are mapped onto the same closed vocabularies (`INTENT_ROUTING_CATEGORY_VOCABULARY`, `INTENT_ROUTING_SUBAGENT_VOCABULARY`). `normalizeObservedDelegation()` handles that for ground truth, including resume calls, which carry no category or subagent and are therefore unscorable rather than wrong. `deriveRoute()` and `derivePredictedRoute()` reduce an observation and a prediction to the same route value so agreement is a single equality. |
| `intent-routing-fixtures.ts` | The hand-labeled corpus, `INTENT_ROUTING_FIXTURES`, with `INTENT_ROUTING_FIXTURE_SOURCES` recording where each case came from. |

**Accuracy harness.** `intent-routing-fixtures.test.ts` is the corpus gate, not a model
benchmark: it fails the suite when the corpus itself degrades. It enforces at least 15
fixtures, no duplicate prompts, every label inside the declared vocabulary, probabilities in
range, at least 3 fixtures whose correct answer is the explicit `none` option, at least 2
non-English prompts (omo heuristics are multilingual, so the corpus must be too), at least 2
continuation cases, and no under-labeled fixture. It also asserts that a wrong answer is
classified as wrong, so the scorer cannot silently pass everything. Grow the corpus by hand
from real disagreements; unlike the W4 fixtures, these are NOT mechanically extractable,
because the sink retains only a 200-character prompt head.

**Vocabulary drift is a real failure mode.** The category and subagent vocabularies here are
copies of values owned by the adapter side. `packages/omo-opencode/src/config/schema/intent-routing-normalization-drift.test.ts`
fails the suite if they fall out of sync. Update both sides in the same change.

## GRACEFUL DEGRADATION CONTRACT

`decide()` never throws and never rejects. Every failure path resolves to `{ status: "unavailable", reason, detail?, latencyMs }` with `reason` drawn from the closed `DecisionUnavailableReason` union:

`disabled` · `missing_api_key` · `timeout` · `transport_error` · `api_error` · `malformed_response` · `unscripted` · `not_implemented`

The consumer's job is then trivial: on anything other than `status: "decided"`, run the existing heuristic unchanged. `decideModelErrorTriage()` implements exactly that fallthrough, and it computes the heuristic result FIRST so the fallback answer exists before any network call is attempted. A `disabled` backend short-circuits without calling `decide()` at all. A thrown error from inside `decide()` is caught and mapped to `transport_error`. The only exception that can escape is one thrown by the injected heuristic itself, which is intentional: that is byte-identical to today's behavior.

## CONFIDENCE POLICY

Jev returns a calibrated confidence in `[0, 1]`. `decideModelErrorTriage()` accepts the model's answer only when `confidence >= confidenceThreshold` (config default `0.8`). Below the threshold it returns the heuristic result with `fellThroughReason: "low_confidence"`, while still populating the `jev` block so the decision can be logged and later mined for eval sets. Uncertainty therefore always resolves toward current behavior, never toward a new one.

Answer validation is part of the same conservatism: probabilities must cover exactly the question's option keys, each in `[0, 1]`, summing to 1 within `PROBABILITY_SUM_TOLERANCE = 0.01` (plus a `1e-9` IEEE epsilon), and `choice` must be an argmax key. Anything else is `malformed_response`, which falls through.

## THE `\bStop\b` GUARD

`script/shared-core-extraction-guard.test.ts` fails the suite if any non-test `.ts` file under a `packages/*-core` package contains the case-sensitive whole word `Stop` (it is a Codex hook-event name, and core packages must stay harness-neutral). The triage question uses a `stop` option, so every occurrence in this package is lowercase on purpose, including comments, criteria prose, and the fixture messages copied out of the classifier. Check before committing:

```bash
grep -rnw "Stop" packages/jev-core/src --include='*.ts' --exclude='*.test.ts'   # must print nothing
```

## DEPENDENCIES & CONSUMERS

- **Depends on:** `@typesafe-ai/sdk` pinned exactly at `0.6.0` (no caret, no tilde) in both `packages/jev-core/package.json` and the root `package.json`. Imported by `src/real-backend.ts` only. No other omo package is a dependency.
- **Consumed by:** `packages/omo-opencode/src/features/jev/` (the OpenCode adapter: reads `JevConfig`, reads `TYPESAFE_API_KEY` from the environment, builds the backend, logs each decision). W4 is wired into `packages/omo-opencode/src/plugin/event-model-fallback.ts`. W1 is wired into the `chat.message` and `tool.execute.before` handlers plus plugin dispose, and everything with IO lives on the adapter side: the turn store, the session gate, the seal timers, and the JSONL sink. `script/jev-w1-report.ts` is a third consumer, reading the sink through the adapter's reader and scoring it with this package's `deriveRoute` / `derivePredictedRoute`. No Codex or Senpi consumer yet.
- **This package still does zero IO.** The W1 record and validation types describe an on-disk format, but nothing here opens a file. The writer and reader are adapter-side (`packages/omo-opencode/src/features/jev/intent-routing-sink.ts` and `intent-routing-sink-reader.ts`), which is why `getIntentRoutingSinkDirectory()` is not exported from here.
- **Privacy, worth knowing before you enable W1.** `IntentRoutingObservationRecord.promptHeadChars` is the first 200 characters of a user message, stored VERBATIM in plain text under `~/.omo/jev/`. No secret scrubbing is performed anywhere in the path. `promptFullSha256` is a digest of the full prompt so recurrences stay countable without keeping the full text, but the head is not hashed. Treat `~/.omo/jev/` as sensitive and never attach it to a public PR.

## WIRES

| Wire | What it replaces | Status |
|------|------------------|--------|
| W4 — model-error triage | substring/regex retry classification in `packages/model-core/src/model-error-classifier.ts` | **Implemented, default off.** Gated on `jev.enabled` AND `jev.wires.model_error_triage.enabled` |
| W1 - intent gate + routing | Phase 0 Intent Gate prose, category/subagent selection | **Implemented, OBSERVE-ONLY, default off.** Gated on `jev.enabled` AND `jev.wires.intent_routing.enabled`. `observe_only` is schema-only and rejects `false`, so no config can make it act. It records predictions against observed delegations; it replaces nothing yet. The seven Phase 0 prose blocks are untouched. |
| W2 — completion/continuation gauntlet | `<promise>DONE</promise>` regex + the idle gauntlet | Not started |
| W3 — stalled/no-progress detection | `/error|failed|failure/i` and zero-token detection | Not started |
| W5 — keyword mode triggers | `\bthink\b`-style keyword regexes | Not started |

**Phase A limitation — `status_code` is always `null`.** `ModelErrorTriageInput` carries an optional `statusCode`, `buildModelErrorTriageState()` maps it to `status_code`, and the `STATUS_CODE` fixtures exercise it. But all three Phase A call sites in `packages/omo-opencode/src/plugin/event-model-fallback.ts` pass only `{ name, message }`, exactly what the heuristic receives at those seams, so in production the `status_code` field of the decision state is `null` on every call. Treat it as a declared-but-unwired signal until a later phase threads the real HTTP status through.

## NOTES

- **Root `AGENTS.md` still says 19 core packages, on purpose.** Only `packages/AGENTS.md` was bumped to 20. Leaving the root file untouched keeps the upstream diff minimal; the count there gets bumped in the upstream PR.
- **The real backend disables SDK-level retries.** One decision equals at most one HTTP attempt; retry policy belongs to the consumer, not to this layer.
- **`MODEL_ERROR_TRIAGE_QUESTION_VERSION`** is stamped into every decision log line. Bump it whenever the question text or criteria change, so old logged decisions are never mixed with new ones in an eval set.
- **Fixtures are extracted mechanically.** `MODEL_ERROR_TRIAGE_FIXTURES` mirrors every string literal of the five pattern lists in the live classifier, and an extraction test fails if the classifier grows a literal without a matching fixture. Do not hand-maintain the list.
- Parent: [`packages/AGENTS.md`](../AGENTS.md).
