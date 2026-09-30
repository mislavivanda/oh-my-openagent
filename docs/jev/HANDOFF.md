# HANDOFF: Jev decision layer for oh-my-openagent ("omo × jev")

> You are running INSIDE the fork this project modifies. The omo plugin orchestrating you
> is the published npm build; changes to this working tree do NOT affect the currently
> running agents. All validation happens via `bun test`, never by restarting opencode.

## Mission
Wire TypeSafe's **Jev** model into oh-my-openagent as a typed decision layer replacing
prompt-text policies and regex/keyword heuristics. Ship as additive, default-off hook
modules → A/B benchmark → approach maintainer (code-yeongyu) with PR + numbers.
Fork-with-receipts is the fallback. Personal project; published free/non-commercial.

## What is Jev (context: it launched 2026-09-15, you may not know it)
- TypeSafe AI "System One Model". NOT an LLM; no text generation.
- `new TypeSafeClient({ apiKey, timeout }).systemOne({ state, questions, model? })` → typed
  decisions with **calibrated probabilities** in 70-500ms. $0.042/MTok in, output free. No
  type errors possible. `model` accepts the alias `jev-latest`, which resolved to
  `jev-1.13.0` in our live probe (2026-09-22, verified against the real API). Primitives: **Choice** (enum ≤255) / **Score** (ordered levels) / **Noul**
  (yes/no probability). Many questions per call, answered in parallel, ~free.
- Docs: docs.typesafe.ai · launch: typesafe.ai/blog/introducing-system-one-models-and-jev
- Access is WAITLIST-GATED, so we may not have API keys yet. Therefore: backend abstraction
  from day one: `real` (npm `@typesafe-ai/sdk`, pinned exactly at `0.6.0`) | `llm-adapter`
  (LLM answering in Jev wire format; Python reference: `typesafe-ai/system-one-adapter-python`)
  | `mock` (deterministic, for tests). Verify wire shapes against typesafe-sdk-js before
  writing the mock.
- Lane check (2026-09-18): zero jev/typesafe issues/PRs in upstream. LangChain shipped
  `langchain-typesafe` middleware (router + tool gating), which is LangChain-locked with no benchmarks.

## Repo state & git rules
- This is a fork of `code-yeongyu/oh-my-openagent` (69k stars, TS monorepo, bun).
  Upstream `dev` churns daily (v5 betas). **All work branches from tag `v4.19.4`.**
- Verify once: `git remote -v` shows upstream `https://github.com/code-yeongyu/oh-my-openagent`
  (add + `git fetch upstream --tags` if missing); work on `jev/*` branches
  (`git checkout -b jev/foundation v4.19.4` if not already on it).
- Baseline before first change: `bun install && bun run test:fast` must be green.
- Tests: `bun test --timeout 20000` (subsets: `test:fast`, `test:codex`, `test:senpi`).
  Match existing `#given/#when/#then` test style.
- `test:fast` did not exist upstream at `v4.19.4`; Phase A added it to the root
  `package.json`. It runs the jev loop only: `packages/jev-core`, the `model-core`
  error-classifier tests, the four `event.model-fallback*` suites including the jev one,
  `packages/omo-opencode/src/features/jev`, `packages/omo-opencode/src/config/schema`, the
  three W1 plugin suites, the two W1 plugin-factory suites, `script/jev-w1-report.test.ts`,
  and the two repo audits (`script/package-registration-audit.test.ts`,
  `script/shared-core-extraction-guard.test.ts`). W2 appended four more targets:
  `packages/omo-opencode/src/hooks/todo-continuation-enforcer` (the whole directory, which
  is where the W2 observer wiring, outcome, idle characterization, and inert proofs live),
  `packages/omo-opencode/src/plugin/hooks/create-continuation-hooks.test.ts`,
  `packages/omo-opencode/src/shared/completion-promise-pattern.test.ts`, and
  `script/jev-w2-report.test.ts`. That addition was append-only; nothing was removed or
  narrowed. Until it landed the gate was blind to those 157 tests: the fast gate went from
  621 tests across 66 files to 778 tests across 89 files with no other change. It is the
  mid-loop check, NOT a substitute for the full suite in final verification.
- Known upstream debt at `v4.19.4`: `THIRD-PARTY-NOTICES.md` lacks headings for
  `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, and `zod`, so
  `node scripts/check-third-party-notices.mjs` is red at baseline; our gates are
  baseline-relative (no NEW missing entry). Not fixed in Phase A; mention in the
  upstream PR.
- License: Sustainable Use License (fair-code); free non-commercial distribution OK,
  fork stays SUL. CLA on upstream PRs grants owner relicensing rights (accepted, known).

## Architecture cheat sheet (line numbers re-verified against v4.19.4 on 2026-09-22)
- Plugin entry/hooks: `packages/omo-opencode/src/plugin-interface.ts`: `tool`(37),
  `chat.params`(39), `chat.headers`(61), `command.execute.before`(63), `chat.message`(68),
  `experimental.chat.messages.transform`(75), `experimental.chat.system.transform`(79),
  `event`(86), `tool.definition`(94), `tool.execute.before`(98), `tool.execute.after`(104).
- ~57 sub-hooks, individually toggleable: `src/config/schema/hooks.ts` (`HookNameSchema`);
  assembly `src/create-hooks.ts:38-103`; `safeCreateHook` isolates crashes; `experimental`
  config block exists → ship everything default-off. Note: `create-hooks.ts` is NOT on the
  W4 path. Model-error triage rides the `event` handler, not the hook registry, so W4
  needed no hook wiring at all.
- Agent roster: primaries = Sisyphus (`sisyphus-agent-factory.ts:40`), Prometheus, Atlas
  (+ Hephaestus on GPT models via `hooks/no-sisyphus-gpt/hook.ts:48-84`). Subagents
  (delegation-only, not in picker): explore, librarian, metis, momus, oracle,
  multimodal-looker (each `const MODE: AgentMode = "subagent"`).
- Key packages: `model-core` (error triage, family detectors), `delegate-core` (model
  selection, retry patterns), `prompts-core`, `boulder-state` (plan checkbox parser),
  `omo-codex` (CLI edition, ulw-loop).
- The "ralph loop" is DORMANT in the live plugin (exported, unwired; CLI-only). Real
  unattended loops: **Atlas/boulder** (`hooks/atlas/`) + **todo-continuation-enforcer**.
- In-repo precedent for our thesis: codex ulw-loop schema-validates completion verdicts
  (`omo-codex/.../quality-gate-verdicts.ts`) while opencode side regex-parses free text:
  "we're finishing a migration they started" (use in PR pitch).
- Heuristics are MULTILINGUAL (think-mode ~30 langs; Chinese error patterns in
  `model-core/src/model-error-classifier.ts:81-124`); evals must cover this.
- Telemetry exists (posthog). Later: log decision outcomes to build eval sets.

## Wire plan (strict order; ONE PLAN PER WIRE)
**W4 - model-error triage** (first: small, provable, icebreaker PR)
- Now: substring lists → retry/stop/ignore: `packages/model-core/src/model-error-classifier.ts:9-188`
  (the five pattern lists through the end of `isRetryableModelError`; `shouldRetryError` is
  the thin export at `:194-196`). Consumer:
  `packages/omo-opencode/src/plugin/event-model-fallback.ts`, three seam sites now calling
  `jevTriage.shouldRetry(...)`, one per handler: `handleAssistantMessageUpdated` (site
  `message.updated`, around `:165`), `handleSessionStatus` (site `session.status`, around
  `:231`), and `handleSessionError` (site `session.error`, around `:292`). **Anchor on the
  handler names, not the line numbers**. Those are indicative only and have already rotted
  twice as this file grew. Terminal-vs-transient:
  `packages/omo-opencode/src/features/background-agent/error-classifier.ts:133-160`.
- A SECOND classifier exists and is NOT covered by W4 yet:
  `packages/model-core/src/runtime-fallback-error-classifier.ts:47-144`
  (`classifyRuntimeFallbackError`), used by the reactive `runtime-fallback` system. It is a
  later W4 target. W4 is inert while `runtime_fallback` is on, because
  `shouldHandleModelFallback()` requires model fallback enabled AND runtime fallback off.
- Jev: `Choice[retry, stop, ignore]` + confidence over error name/message/status.
  Existing pattern lists become test fixtures/labels. Low confidence → current heuristic.

**W1 - intent gate + routing** (implemented, observe-only)
- The six Sisyphus Phase 0 prose blocks are
  `packages/omo-opencode/src/agents/sisyphus-dynamic-prompt-role.ts:25-112`,
  `packages/omo-opencode/src/agents/sisyphus/claude-opus-5.ts:192-276`,
  `packages/omo-opencode/src/agents/sisyphus/claude-opus-4-8.ts:178-262`,
  `packages/omo-opencode/src/agents/sisyphus/claude-fable-5.ts:178-262`,
  `packages/omo-opencode/src/agents/sisyphus/claude-opus-4-7.ts:178-262`, and
  `packages/omo-opencode/src/agents/sisyphus/default.ts:189-261`. Hephaestus carries the
  corresponding block at `packages/omo-opencode/src/agents/hephaestus/gpt.ts:126-169`.
  Category prose and subagent tables remain unchanged. Stage 2 category-to-model routing
  remains deterministic and untouched.
- W1 records a pre-turn `intent: Choice(6)`, `category: Choice(~8)`,
  `subagent: Choice(N)`, and `ambiguous: Noul`, then correlates those predictions with
  actual delegation attempts. It does not inject a directive, shorten Phase 0, or change
  routing behavior. `observe_only` is required to remain `true`.

**W2 - completion/continuation gauntlet** (implemented, observe-only)
- Now: `<promise>DONE</promise>` regex (`hooks/ralph-loop/constants.ts:3`,
  `completion-promise-detector.ts:32-34`); 14-condition gauntlet
  (`hooks/todo-continuation-enforcer/idle-event.ts:20-249`); stagnation counters
  (`stagnation-detection.ts:6-36`); boulder checkboxes (`boulder-state/src/plan-checklist.ts:5-16`).
- Jev: `actually_complete` / `progressing` / `stuck` Nouls over todo state + a bounded
  transcript tail + the cached `session.diff` stat + a boulder checklist summary.
- **Correction to the earlier plan wording.** An earlier revision of this file said W2
  "Gates loop exit AND re-prompt injection". As built it gates NOTHING. W2 records three
  probabilities beside the live gauntlet, records the gauntlet's exact outcome, then keeps
  the record open for a later observable outcome. It does not gate loop exit, alter
  `<promise>DONE</promise>` handling, suppress or add a continuation, change countdowns,
  change prompt injection, or replace stagnation logic. `observe_only` is schema-only and
  rejects `false`; there is no runtime branch on it and no apply method. The apply path is
  deferred to a later phase.
- **Why W2 measures instead of applying.** Continuation was Jev's worst class in W1. Both
  W1 continuation fixtures failed, because W1 sent no conversation history at all:
  `continue` became implementation-to-open-ended and `go on` became research-to-open-ended.
  W2 is the continuation gauntlet itself. Gating loop exit or re-prompt injection on a
  signal measured that weak could hang a long-running loop or kill it early. W2 therefore
  sends a bounded transcript tail to partially address the no-history weakness, records the
  result, and changes no decision.
- **There is no accuracy threshold.** Not in the tests, not in the report, not in the
  success criteria, not in any PR gate. A poor score is the finding, not a failure.
- **Measured against the real API (todo 18, requested `jev-latest`, resolved
  `jev-1.13.0`, 18 of 18 budgeted calls, question version 1).** Do not read these numbers
  as good:
  - `actually_complete`: 15 of 16 known-label fixtures decided correctly, 1 uncertain.
  - `progressing`: **2 of 15** known-label fixtures decided correctly. Every
    true-progressing fixture landed in the uncertain band; 14 of 18 fixtures were
    uncertain.
  - `stuck`: 8 of 15 known-label fixtures decided correctly; 10 of 18 uncertain.
  - On the two W1-worst-class continuation fixtures (`continue-after-red-test`,
    `go-on-after-source-review`) the bounded transcript tail helped on **exactly one of
    three** questions. It correctly and confidently rejected completion (0.06 and 0.06)
    but missed `progressing` (0.38 and 0.42) and `stuck` (0.26 and 0.28), both inside the
    uncertain band. At the 0.8 threshold both fall through to the heuristic, so an
    observe-only wire would change nothing for them today.
  - The two deliberately-censored fixtures were answered `would_false` on
    `actually_complete` rather than left uncertain, a confident answer to a question whose
    truth is unknowable from the state. Carry that into question design; it is not a gate.
- Report: `bun run script/jev-w2-report.ts --root <dir>` prints denominators first, then
  heuristic agreement and observable-outcome agreement in separate sections with separate
  denominators. It never merges them and never prints a threshold verdict.

**W3 - stalled/no-progress** (feeds W2): replaces `/error|failed|failure/i`
(`hooks/atlas/tool-progress.ts:3-10`), zero-token detection
(`ralph-loop/no-progress-turn-detector.ts:74-119`), circuit breaker
(`background-agent/loop-detector.ts:90-102`).

**W5 - keyword mode triggers** (careful, behavior-changing): `\bthink\b` etc.
(`hooks/keyword-detector/constants.ts:14-54`, `think-mode/detector.ts:1-50`).

**v2 - context-pruning relevance scoring**: their `dynamic-context-pruning` ships
default-disabled (`config/schema/dynamic-context-pruning.ts:3-49`); Jev per-item relevance
Nouls could make it safe to enable. Big token number, later.

## Design rules (non-negotiable)
1. Additive modules only; minimal upstream diffs. As built in Phase A: the harness-neutral
   package is `packages/jev-core/` and the OpenCode adapter is
   `packages/omo-opencode/src/features/jev/` (the earlier `packages/omo-jev/` name was
   dropped in favor of the repo's `*-core` + adapter layering).
2. Every wire behind its own config flag, DEFAULT OFF.
3. **Graceful degradation**: Jev timeout / low confidence / no API key → fall through to
   existing heuristic. Never block or alter behavior when Jev is absent.
4. Thresholds use calibrated probabilities; uncertain → conservative (= current behavior).
5. DecisionBackend abstraction (`real | llm-adapter | mock`) from day one.
6. Commit checkpoints every few TODOs; `bun run test:fast` mid-loop (see its exact scope
   under Repo state & git rules); full suite in final verification only.

## Benchmark plan (the receipts)
Same task set, wire flags ON vs OFF. Metrics: total tokens, wall-clock, task success,
false-done count, zombie iterations killed, per-decision latency/cost. Include
multilingual + adversarial cases. Lives in `bench/`. Powers the PR pitch + writeup.

## Execution workflow (how WE work in this repo, session by session)
- Phase plan: **Prometheus** (max/xhigh effort) reads this file, interviews the user,
  produces a boulder plan for ONE wire only. Momus loops until [OKAY]; user reads and
  approves before execution. Plans must include: commit checkpoints, test:fast mid-loop
  checks, Final Verification Wave demanding full `bun test` green as evidence, dogfood-log
  upkeep.
- Execution: **Atlas** (high effort) runs the plan. Human stays present for the sensitive
  touchpoints. In Phase A that was the config schema edit only: W4 rides the `event`
  handler, so no `create-hooks.ts` wiring was needed.
- Odd jobs/debug: **Sisyphus** interactive (add `ultrawork` only for multi-step asks).
- One opencode session per wire; state carries via plan files + this doc + dogfood log.
- Current phase: **W2 implemented in observe-only mode**, on top of W1 and W4. W2 asks
  `actually_complete`, `progressing`, and `stuck` at each eligible idle decision, records
  the live gauntlet's exact outcome, holds the record open for a later observable outcome,
  and writes bounded JSONL observations without changing any continuation behavior.
  W1 remains implemented in observe-only mode: it adds intent, category, subagent, and
  ambiguity predictions; captures actual delegation attempts; and writes bounded JSONL
  observations without changing prompt or routing behavior.

## Dogfood config
Turn W4 on for your own sessions. Everything is default-off, so this is the only switch.
Put this in `~/.omo/omo.jsonc` (the unified config; the `[opencode]` block is the plugin's):

```jsonc
{
  "[opencode]": {
    "model_fallback": true,
    "jev": {
      "enabled": true,
      "backend": "real",
      "model": "jev-latest",
      "timeout_ms": 1500,
      "wires": {
        "model_error_triage": {
          "enabled": true,
          "confidence_threshold": 0.8
        },
        "intent_routing": {
          "enabled": true,
          "observe_only": true,
          "confidence_threshold": 0.8,
          "timeout_ms": 2500,
          "turn_seal_timeout_ms": 120000,
          "max_prompt_chars": 8000,
          "max_inflight": 8
        }
      }
    }
  }
}
```

The API key never goes in the config. Export it:

```bash
export TYPESAFE_API_KEY=...
```

W1 writes process-specific `w1-*.jsonl` sink files under `~/.omo/jev/`. Each observation
stores the prompt head in `promptHeadChars` along with a full-prompt SHA-256 digest,
prediction fields, and observed delegation attempts. Prompt heads are stored verbatim in
the sink. The sink does not scrub secrets, so protect this directory as session data.

### W2 dogfood config (observe-only)

W2 is independently default-off. This is the exact opt-in block, and the API key stays
environment-only:

```jsonc
{
  "[opencode]": {
    "jev": {
      "enabled": true,
      "backend": "real",
      "model": "jev-latest",
      "wires": {
        "completion_continuation": {
          "enabled": true,
          "observe_only": true,
          "confidence_threshold": 0.8,
          "timeout_ms": 2500,
          "outcome_window_ms": 120000,
          "max_inflight": 8,
          "max_state_bytes": 24576
        }
      }
    }
  }
}
```

```bash
export TYPESAFE_API_KEY=...
```

`observe_only: false` is rejected at parse time with an apply-phase message, so the block
above is the only shape that validates. `outcome_window_ms` must stay strictly greater
than `timeout_ms`.

W2 writes process-specific `w2-*.jsonl` sink files under `~/.omo/jev/`, alongside the W1
files and independent of them. Records are bounded before they are sent and before they
are stored: at most 32 todo items (256 UTF-8 bytes of content each), the last 8
non-synthetic user or assistant messages (1500 bytes each, 12000 bytes total), at most 32
changed paths from the cached `session.diff` event (4096 bytes total), a boulder summary
with a 256-byte next-task title, and a 24576-byte cap on the final serialized state, with
every truncation recorded as a flag. No `FileDiff` `before` or `after` content is ever
retained, and diff state never comes from a shell command or an awaited diff request on
the idle path. Each record stays open for up to `outcome_window_ms` (120000 ms by default)
waiting for a decisive later snapshot; timeout, dispose, session deletion, and human
intervention are recorded as censored, never as `stuck`.

One-line check that the prerequisite flag is actually set:

```bash
grep -c '"model_fallback": true' ~/.omo/omo.jsonc
```

**W4 is inert unless `model_fallback` is true AND `runtime_fallback` is off.** The three
seam sites sit behind `shouldHandleModelFallback()`, which returns false when runtime
fallback is enabled, so a jev config alone changes nothing. Restart opencode after editing.

**Warning: `runtime_fallback.enabled: true` silently disables W4.** `shouldHandleModelFallback()`
requires model-fallback on AND runtime-fallback off, so flipping runtime-fallback on makes all
three seam sites go inert with zero `[jev]` lines and no error or log saying why. `runtime_fallback`
defaults to `false`, so W4 is active out of the box; this only bites if you turn runtime-fallback
on deliberately. If you enable W4 and see zero `[jev]` lines, check this first.

## Revision log
- 2026-09-30 W2 implemented in observe-only mode:
  - Replaced the old W2 wire wording "Gates loop exit AND re-prompt injection" with what
    was actually built: W2 gates nothing, `observe_only` rejects `false`, and the apply
    path is deferred.
  - Recorded the real-API baseline honestly: strong `actually_complete`, weak
    `progressing` at 2 of 15, middling `stuck` at 8 of 15, and a bounded transcript tail
    that helped on exactly one of three questions for the two W1-worst-class continuation
    fixtures.
  - Stated that no accuracy threshold exists anywhere in W2.
  - Added the W2 dogfood config block, the `w2-*.jsonl` sink contract, the bounded input
    caps, the no-retained-diff-content guarantee, and the censoring rules.
  - Corrected the `test:fast` scope: W2 appended the `todo-continuation-enforcer`
    directory plus three files, append-only, taking the gate from 621 to 778 tests.
- 2026-09-24 W1 implemented in observe-only mode:
  - Corrected W1 references to the six Sisyphus Phase 0 blocks and the Hephaestus block.
  - Added intent-routing dogfood config and documented the `~/.omo/jev/` JSONL sink.
  - Recorded that prompt heads are persisted verbatim and are not secret-scrubbed.
- 2026-09-19 Phase A audit against `v4.19.4` (line numbers re-verified 2026-09-22):
  - API shape corrected to `new TypeSafeClient(...).systemOne({ state, questions, model? })`;
    alias `jev-latest` confirmed by live probe to resolve to `jev-1.13.0`.
  - SDK package corrected to `@typesafe-ai/sdk`, pinned exactly at `0.6.0`.
  - `test:fast` documented: it did not exist upstream, Phase A added it, and its scope is
    now spelled out under Repo state & git rules.
  - `plugin-interface.ts` handler line numbers re-verified: `event` `87`→`86`,
    `tool.definition` `95`→`94`, `tool.execute.before` `99`→`98`, `tool.execute.after`
    `105`→`104`; `chat.headers`(61) added. `create-hooks.ts` noted as not on the W4 path.
  - W4 refs corrected to full repo-root paths: classifier `:9-189`→`:9-188`, consumer seam
    sites `:36-100`→ the three named handlers, terminal-vs-transient `:151-178`→`:133-160`;
    the second classifier `runtime-fallback-error-classifier.ts:47-144` added as a later
    W4 target.
  - Seam line numbers in `event-model-fallback.ts` are INDICATIVE, not anchors. They have
    gone stale twice in Phase A (the plan's own `:127,171,208`, then a first draft of this
    section that paired the right numbers with swapped site labels). The stable anchor is
    the handler function name paired with its `site` string:
    `handleAssistantMessageUpdated`/`message.updated`, `handleSessionStatus`/`session.status`,
    `handleSessionError`/`session.error`. Re-derive numbers with grep before trusting them.
  - Package layout corrected: `packages/jev-core/` plus adapter
    `packages/omo-opencode/src/features/jev/`, not `packages/omo-jev/`.
  - Phase A human touchpoint narrowed to the config schema edit only.
  - Current-phase status rewritten for `jev/phase-a`.
  - Added the dogfood-config section and the `THIRD-PARTY-NOTICES.md` baseline-debt bullet.

## Dogfood log (mandatory)
`docs/jev/dogfood-log.md`. Every omo loop misbehavior observed while building this,
false `<promise>DONE</promise>`, zombie loop, stagnation miss, keyword false-trigger,
intent-gate misroute, gets one dated line + session context. These become W1/W2 test
cases and PR-pitch evidence.
