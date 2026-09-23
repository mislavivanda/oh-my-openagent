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

`answer-validation.ts` is deliberately NOT exported from the barrel. It is the single internal definition of "well-formed answer" shared by the mock and real backends, and both return the guarded original object so `answers` typechecks as `{ [K in keyof Q]: AnswerFor<Q[K]> }` with no cast.

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
- **Consumed by:** `packages/omo-opencode/src/features/jev/` (the OpenCode adapter: reads `JevConfig`, reads `TYPESAFE_API_KEY` from the environment, builds the backend, logs each decision), which in turn is wired into `packages/omo-opencode/src/plugin/event-model-fallback.ts`. No Codex or Senpi consumer yet.

## WIRES

| Wire | What it replaces | Status |
|------|------------------|--------|
| W4 — model-error triage | substring/regex retry classification in `packages/model-core/src/model-error-classifier.ts` | **Implemented, default off.** Gated on `jev.enabled` AND `jev.wires.model_error_triage.enabled` |
| W1 — intent gate + routing | Phase 0 Intent Gate prose, category/subagent selection | Not started |
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
