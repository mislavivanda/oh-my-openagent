# Jev Phase A Evidence

- Branch: `jev/phase-a`
- Base: `jev/foundation`
- Date: 2026-09-22
- Bun: 1.4.0; CI pin: 1.3.12
- OpenCode: 1.18.32
- Evidence manifest: `MANIFEST.tsv`

## Baseline decision

The user explicitly accepted the Bun version drift without a local downgrade. The full-suite acceptance is therefore zero new failure names relative to `task-1-baseline-failures.txt`, not a fabricated zero-failure result. Todo 16 records 22 failure lines, 21 unique normalized names, and no additions or omissions in `task-16-baseline-delta.txt`. This deliberate deviation from the plan's literal `0 fail` text is user-approved.

The known upstream notices debt at v4.19.4 is also baseline-relative. `THIRD-PARTY-NOTICES.md` lacks headings for `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, and `zod`. The plain notices gate must report exactly those four entries; `@typesafe-ai/sdk` must remain absent.

## Todo 1: frozen baseline and evidence controls

**WHAT WAS TESTED:** `bun test --timeout 20000`, full typecheck, plain and ship notices checks, branch identity, evidence manifest creation, path/credential scrub probes, and the clean `jev/foundation` baseline.

**WHAT WAS OBSERVED:** `task-1-baseline-full.txt` records 12,643 passes, 3 skips, and 22 environment-caused failures. `task-1-baseline-typecheck.txt` passed. Plain notices produced the exact four upstream entries and ship mode exited 0. The frozen names are in `task-1-baseline-failures.txt`.

**WHY IT IS ENOUGH:** The baseline predates Phase A product code and provides mechanical comparison points for tests, notices, package files, and evidence hygiene.

**WHAT WAS OMITTED:** Raw installer and ship-check output, environment dumps, credentials, and machine-local paths were not retained.

## Todo 2: integration handoff and dogfood log

**WHAT WAS TESTED:** The initial Jev handoff and dogfood documents were committed, the first checkpoint subject was verified, and the tracked Markdown audit was run.

**WHAT WAS OBSERVED:** `task-2-first-commit.txt` confirmed the checkpoint and `task-2-markdown-audit.txt` passed 16 tests with zero failures.

**WHY IT IS ENOUGH:** The checkpoint establishes the integration contract and traceable dogfood record before implementation changes.

**WHAT WAS OMITTED:** No provider traffic, credentials, or untracked draft material was captured.

## Todo 3: harness-neutral package scaffold

**WHAT WAS TESTED:** The `packages/jev-core/` package boundary, package typecheck, registration audit, and source inventory were checked.

**WHAT WAS OBSERVED:** `task-3-typecheck.txt` exited 0, `task-3-audit.txt` passed 6 tests, and `task-3-ls.txt` showed only the intended `index.ts` scaffold.

**WHY IT IS ENOUGH:** Registration and package-boundary checks prove the new core package is recognized without importing an adapter harness.

**WHAT WAS OMITTED:** Backend behavior was intentionally deferred to Todos 6 through 9; no secrets or network calls were involved.

## Todo 4: default-off Jev schema

**WHAT WAS TESTED:** A failing schema test was captured before implementation, then the Jev config schema, defaults, generated schemas, and human checkpoint were verified.

**WHAT WAS OBSERVED:** `task-4-schema-red.txt` failed 1 test as expected; `task-4-schema-green.txt` passed 6. The schema is default-off and has no credential field. `task-4-schema-checkpoint.txt` preserves the conditional user response and the later user-ratified decision to defer installer prompting.

**WHY IT IS ENOUGH:** The RED/GREEN pair pins config shape and defaults, while the checkpoint makes the scope decision reviewer-auditable.

**WHAT WAS OMITTED:** The API key was not read or stored. Installer prompting is a documented follow-up, not Phase A work.

## Todo 5: SDK registration and authoritative declarations

**WHAT WAS TESTED:** Exact dependency registration, lockfile/package audits, typecheck, notices coverage, unchanged package `files[]`, and installed SDK declarations were checked.

**WHAT WAS OBSERVED:** The registration audit moved from 5 passes plus 1 failure to 6 passes. `task-5-typecheck.txt` passed. `task-5-register.txt` records `@typesafe-ai/sdk` 0.6.0 and all 19 named declaration shapes. Plain notices remained at the four known upstream entries and the files diff was empty.

**WHY IT IS ENOUGH:** The installed declaration copy and registration gates prove the code targets the actual pinned SDK and does not alter publication scope.

**WHAT WAS OMITTED:** Raw install output and any credential-bearing environment data were omitted.

## Todo 6: deterministic mock backend

**WHAT WAS TESTED:** Disabled and scripted mock backend behavior was exercised with failing-first tests followed by the implementation run.

**WHAT WAS OBSERVED:** `task-6-mock-backend-red.txt` failed 2 tests before implementation and `task-6-mock-backend-green.txt` exited 0 afterward.

**WHY IT IS ENOUGH:** The deterministic mock is the basis for adapter, seam, race, and real-harness fallthrough tests without network variability.

**WHAT WAS OMITTED:** No live service, credential, or raw request was used.

## Todo 7: real SDK backend

**WHAT WAS TESTED:** Real-backend response validation, missing-key handling, HTTP errors, timeout, connection failures, single-fetch retry policy, package typecheck, and harness-neutral extraction were covered.

**WHAT WAS OBSERVED:** `task-7-real-backend-red.txt` recorded 14 expected failures before implementation; `task-7-real-backend-green.txt` passed 16 tests. Typecheck and the 3-test shared-core guard passed. The installed SDK exposed parsed `APIError.body`, and timeout surfaced as `APITimeoutError`.

**WHY IT IS ENOUGH:** Injected transport tests exercise the real SDK runtime while proving every transport or validation failure degrades to an unavailable decision and performs no hidden retry.

**WHAT WAS OMITTED:** No real key or production request was used in this todo; injected responses replaced external traffic.

## Todo 8: model-error triage contract and fixtures

**WHAT WAS TESTED:** Question/state construction, response validation, confidence policy, status-code handling, and the complete classifier-derived fixture corpus were implemented through RED/GREEN tests.

**WHAT WAS OBSERVED:** `task-8-triage-wire-red.txt` failed before the wire existed and `task-8-triage-wire-green.txt` passed 18 tests. The corpus contains 94 fixtures, with the retry/stop overlap assigned to stop precedence.

**WHY IT IS ENOUGH:** The fixture corpus binds the decision layer to existing heuristic behavior across every named classifier entry and edge case.

**WHAT WAS OMITTED:** No API credential or live decision call was needed for deterministic contract coverage.

## Todo 9: backend selector and public API

**WHAT WAS TESTED:** Backend selection for disabled, mock, real, and placeholder modes plus the complete package barrel export set was exercised through RED/GREEN tests.

**WHAT WAS OBSERVED:** `task-9-selector-red.txt` failed before the selector existed; `task-9-selector-green.txt` passed 86 tests across 7 files. `task-9-barrel-keys.txt` records the 13 public exports.

**WHY IT IS ENOUGH:** Consumers can select one backend through a stable harness-neutral API, with disabled and placeholder modes preserving graceful fallback.

**WHAT WAS OMITTED:** Adapter wiring and real OpenCode lifecycle traffic were deferred to Todos 11, 12, and 15.

## Todo 10: live Jev API probe

**WHAT WAS TESTED:** The live probe ran for real after the user supplied a key: exactly three sequential service calls, one each for retry, stop, and ignore fixtures, with no loops or retries.

**WHAT WAS OBSERVED:** `task-10-live-probe.txt` records `probe_exit=0`; all calls returned `status:"decided"`, matched their labels, used model `jev-1.13.0`, and reported confidences 0.96, 1.0, and 0.82 with latencies from 159 to 303 ms.

**WHY IT IS ENOUGH:** This independently proves the handwritten response mirror accepts production responses, probability validation succeeds, `jev-latest` resolves as expected, and the 1,500 ms default timeout has margin.

**WHAT WAS OMITTED:** The key value, request headers, token usage, and raw service transport were not retained. A whole-evidence key-leak scan reported zero matches.

## Todo 11: OpenCode Jev adapter

**WHAT WAS TESTED:** Disabled behavior, applied ignore, unscripted fallback, backend and heuristic exceptions, logger exceptions, missing key, fixture agreement, package typecheck, registration audit, and mechanical completeness extraction from all classifier lists were checked.

**WHAT WAS OBSERVED:** `task-11-adapter-red.txt` failed only because the adapter module was absent; `task-11-adapter-green.txt` passed 10 tests. Completeness found no missing or misattributed fixture, including the stop-precedence overlap.

**WHY IT IS ENOUGH:** The unit boundary exercises every adapter decision and failure mode before runtime call sites are added.

**WHAT WAS OMITTED:** Real OpenCode was intentionally deferred until the adapter was wired. No credential or raw SDK logging was captured.

## Todo 12: model-fallback runtime seam

**WHAT WAS TESTED:** All three model-fallback event sites, duplicate suppression, deletion races, reservation cleanup, package typecheck, the full plugin suite, unchanged legacy tests, and a real isolated OpenCode HTTP plus SSE deletion event were checked.

**WHAT WAS OBSERVED:** `task-12-seam-red.txt` recorded 14 failures before wiring; the GREEN run exited 0. The plugin suite passed 587 tests, typecheck passed, and `task-12-opencode-sse-qa.txt` records HTTP 200, one `session.deleted` event, and host sessions unchanged at 317.

**WHY IT IS ENOUGH:** Deterministic race tests pin disabled-path preservation and ABA-safe cancellation, while the isolated server receipt proves the lifecycle hook receives the real event wire.

**WHAT WAS OMITTED:** Provider credentials, auth headers, sandbox roots, raw SSE payloads, and server passwords were not retained.

## Todo 13: fast verification gate

**WHAT WAS TESTED:** The root `test:fast` command and package-registration audit were run against all 11 intended paths.

**WHAT WAS OBSERVED:** `task-13-test-fast.txt` records 317 passing focused tests plus 6 passing registration-audit tests, with zero failures.

**WHY IT IS ENOUGH:** The command provides a repeatable focused regression gate spanning core, adapter, schema, model-fallback, and architecture audits.

**WHAT WAS OMITTED:** Unrelated full-suite tests were intentionally excluded from this fast gate and remain covered by Todos 1 and 16.

## Todo 14: package and handoff documentation

**WHAT WAS TESTED:** `packages/jev-core/AGENTS.md`, `packages/AGENTS.md`, `docs/jev/HANDOFF.md`, and `docs/jev/dogfood-log.md` were staged before acceptance greps and the tracked Markdown audit.

**WHAT WAS OBSERVED:** `task-14-docs.txt` records the 20-core-package map, corrected handler/site pairs, dogfood and revision sections, no local paths, and 16 Markdown audit passes.

**WHY IT IS ENOUGH:** The documentation is checked against runtime symbol names and package counts instead of relying on stale line-number assumptions.

**WHAT WAS OMITTED:** No product behavior, credentials, or machine-local links were added; installer follow-up remains outside this phase.

## Todo 15: isolated real-harness Jev smoke

**WHAT WAS TESTED:** Real OpenCode 1.18.32 loaded this tree's source plugin in two isolated HOME/XDG sandboxes. The accepted surface was server+SSE, not `opencode run`: an authenticated `prompt_async` request hit a local HTTP 429 provider and the global event stream, once with Jev enabled and once disabled.

**WHAT WAS OBSERVED:** `task-15-load-smoke.txt` records enabled P0/P1/P2 pass with one Jev line, disabled P0/P1/P2 pass with zero Jev lines, no uncaught errors, and host DB sessions unchanged from 320 to 320. `task-15-jev-log-enabled.txt` captures the `[jev] model-error-triage` line at `site:"session.status"`, `backend:"mock"`, `status:"fell_through"`, `reason:"unscripted"`, and `shouldRetry===heuristicShouldRetry===true`.

**WHY IT IS ENOUGH:** The server+SSE surface exposes the retry lifecycle event consumed by the seam. `opencode run --format json` was rejected as the driver because it returned rc 0 with no output while the provider returned HTTP 429 three times, so it could not prove lifecycle delivery. Enabled/disabled parity isolates the Jev gate, and the DB count proves host-state isolation.

**WHAT WAS OMITTED:** `TYPESAFE_API_KEY` stayed unset. Provider credentials, auth headers, server passwords, raw environment dumps, sandbox roots, and the user's live server were not touched or retained.

## Todo 16: final verification and checkpoint

**WHAT WAS TESTED:** The full suite, full typecheck, clean build, fresh `dist/index.js` mtime, bundled SystemOne endpoint marker, plain and ship notices modes, unchanged package `files[]`, `test:fast`, baseline failure delta, pass-count delta, evidence scrub, manifest completeness, staged Markdown audit, and ordered checkpoint history were checked.

**WHAT WAS OBSERVED:** `task-16-bun-test.txt` records 12,762 passes, 3 skips, and the same 22 baseline failure lines with `exit=1`; `task-16-baseline-delta.txt` records zero new names. `task-16-typecheck.txt`, `task-16-build.txt`, and `task-16-test-fast.txt` exit 0. The clean build matched `/v1/systemone` once in the fresh bundle. Plain notices produced exactly the four upstream entries, ship mode stayed at exit 0, and `task-16-files-gate.txt` is an empty diff. `task-16-tests-added.txt` records `tests_added=119`.

**WHY IT IS ENOUGH:** These gates cover compilation, packaging, publication scope, dependency bundling, focused behavior, complete behavior relative to the user-approved environment baseline, evidence integrity, and final commit ordering.

**WHAT WAS OMITTED:** Raw ship-check output, secrets, auth material, private environment state, and machine-local paths were omitted. The full-suite failures were not hidden or rewritten; their accepted baseline status is explicit above.

## Scrub inspection note

The literal secret-shape expression produced two false-positive file hits during its first run. Mandatory evidence basenames contain the substring `sk-` as the tail of `task-`, followed by long hyphenated words, which accidentally satisfies the unbounded `sk-` token pattern. Both files were hand-inspected and contained only reviewer prose and manifest basenames, not secret values. The final rerun retained every other expression unchanged and added a non-alphanumeric token boundary to the `sk-` alternative so mandatory `task-` basenames do not mask the real zero-secret result.

The path scan also found temporary test directories in the Todo 1 and Todo 16 full-suite transcripts plus a path-scan heading in the Todo 14 receipt. The temporary values were replaced with `<temporary-path>`, the heading was rewritten without literal machine-root examples, and the gate was rerun on those exact bytes.

Manifest validation found that the composite Todo 13 receipt recorded successful subcommand exits but lacked the required terminal `exit=0` line. Hand inspection confirmed all three embedded checks passed, so the canonical terminal line was added and manifest validation was rerun. The Todo 12 SSE receipt kind was also normalized from an unsupported label to `gate` without changing its expected exit.

## Final Verification Wave

This section post-dates the rest of this index. Everything above was written at Todo 16, before the Final Verification Wave ran and before the F2 remediation existed. The wave ran four independent reviews (F1 plan compliance, F2 code quality, F3 real manual QA, F4 scope fidelity) against final HEAD. All four ended at APPROVE, but F2 got there only after a genuine REJECT and a remediation commit, so the phase now stands at **8 commits** on `jev/phase-a`: the plan's seven checkpoints plus the review-driven remediation. The merge into `jev/foundation` (F5) is gated on explicit user approval and was not performed.

**WHAT WAS TESTED:** F1 re-ran every rerunnable gate on final HEAD instead of trusting the Todo 16 transcripts, and reconciled the evidence manifest against the directory. F2 read the Phase A diff for code quality, including per-file size against the repo's LOC rule. F3 ignored the committed smoke result and re-ran the real-harness smoke itself into a scratch directory. F4 enumerated every changed path against the plan's authorized change set and its Must-NOT list.

**WHAT WAS OBSERVED:**

- **F1 plan compliance: APPROVE.** The full suite independently reproduced at 12,762 passes against the 22 accepted baseline failures, with `new_failure_count=0`. The manifest reconciled 1:1 with the files on disk, and all seven plan commit subjects were present in order.
- **F2 code quality: REJECT, then APPROVE after remediation.** Two file-size findings, detailed below.
- **F3 real manual QA: APPROVE.** The fresh smoke exited 0 and every predicate matched the committed summary. The real OpenCode DB was unchanged within the run at 325 sessions before and 325 after, `test:fast` passed 317 of 317, and the confidence boundary behaved exactly as specified: 0.8 lets the Jev decision win, 0.7999 falls back to the heuristic and reports `low_confidence`.
- **F4 scope fidelity: APPROVE.** All 119 changed paths trace to authorizations C1 through C6 or to the commit strategy. Every Must-NOT path is absent, the Jev schema carries no credential field, and `packages/omo-opencode/src/cli/**` is untouched, which is the correct shape for deferring installer integration out of this phase.

**The F2 remediation.** The finding was that `packages/omo-opencode/src/plugin/event-model-fallback.ts` stood at 307 pure LOC and `packages/omo-opencode/src/features/jev/model-error-triage.test.ts` at 259 pure LOC, neither carrying the `// allow: SIZE_OK` marker the repo requires for an oversized module. This was a real finding rather than pre-existing noise: `event-model-fallback.ts` measured 218 pure LOC on `jev/foundation`, and the Todo 12 seam work is what pushed it to 307. The violation was created by this work.

The resolution was a documented justification using the repo's established `// allow: SIZE_OK` convention, which 24 other files already use, and deliberately not a structural split. Splitting concurrency code that had just passed 17 cases (A through H7) plus a real-harness smoke would have invalidated that evidence for no behavioral gain. Each justification names what keeps its file cohesive and how a future edit should split it once the shape changes. Commit `3dd9f113e` is comment-only for both files, two added lines each, with no logic, assertion, or behavior changed. F2 re-reviewed the result and returned APPROVE.

**A caught regression, recorded on purpose.** The first attempt at that commit, `66cebfa68`, also appended seven bogus rows to `MANIFEST.tsv`. Those rows were check *labels* rather than filenames: `jev-triage-tests`, `plugin-tests`, `jev-tsgo`, `test-fast`, `logger-count`, `index-first-line`, and `stop-check`. That left 83 manifest rows against 76 real evidence files and would have failed F1's "file listed in MANIFEST is missing" criterion. Orchestrator review caught it before it went anywhere, the commit was amended to `3dd9f113e`, and manifest integrity was re-verified at 76 rows, 76 unique names, and 76 files, with zero duplicates, zero missing entries, and zero orphans. Near-misses are exactly what an evidence trail is for, so it is written here plainly rather than dropped.

**Evidence file added by the wave:** `task-F2-remediation.txt` (kind `gate`, expected `0`), the post-remediation verification transcript covering the Jev and plugin suites, package typecheck, `test:fast`, the mechanical invariant checks, and the measured pure LOC for both files.

**WHY IT IS ENOUGH:** F1 and F3 are independent reproductions rather than re-readings, so the committed transcripts are corroborated by fresh runs on final HEAD. F2 covers the one quality dimension the mechanical gates do not enforce, and its REJECT proves the review was capable of failing. F4 bounds the change set against the plan, which is what keeps a deferred installer integration from silently leaking into this phase. The manifest recount closes the one integrity regression the wave introduced.

**WHAT WAS OMITTED:** Raw review transcripts, provider credentials, scratch sandbox roots, and machine-local paths were not retained. The F5 merge is out of scope for this record because it has not happened. The five modified generated `dist` files in the working tree come from `bun install`'s `prepare` script, are known-acceptable, and were never staged.

## F5 post-merge verification

The post-merge run on `jev/foundation` recorded 12,762 passes, 3 skips, and 22 failures with `exit=1` under Bun 1.4.0. Mechanical timing-normalized comparison found 21 unique failure names, all within the user-approved frozen baseline, with zero new failures and zero missing baseline failures. This baseline-relative result intentionally replaces the plan's literal zero-failure gate; raw installer output, credentials, machine-local paths, and private environment state were not retained.
