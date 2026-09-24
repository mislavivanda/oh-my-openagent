# HANDOFF: Jev decision layer for oh-my-openagent ("omo × jev")

> You are running INSIDE the fork this project modifies. The omo plugin orchestrating you
> is the published npm build - changes to this working tree do NOT affect the currently
> running agents. All validation happens via `bun test`, never by restarting opencode.

## Mission
Wire TypeSafe's **Jev** model into oh-my-openagent as a typed decision layer replacing
prompt-text policies and regex/keyword heuristics. Ship as additive, default-off hook
modules → A/B benchmark → approach maintainer (code-yeongyu) with PR + numbers.
Fork-with-receipts is the fallback. Personal project; published free/non-commercial.

## What is Jev (context - it launched 2026-09-15, you may not know it)
- TypeSafe AI "System One Model". NOT an LLM - no text generation.
- `new TypeSafeClient({ apiKey, timeout }).systemOne({ state, questions, model? })` → typed
  decisions with **calibrated probabilities** in 70-500ms. $0.042/MTok in, output free. No
  type errors possible. `model` accepts the alias `jev-latest`, which resolved to
  `jev-1.13.0` in our live probe (2026-09-22, verified against the real API). Primitives: **Choice** (enum ≤255) / **Score** (ordered levels) / **Noul**
  (yes/no probability). Many questions per call, answered in parallel, ~free.
- Docs: docs.typesafe.ai · launch: typesafe.ai/blog/introducing-system-one-models-and-jev
- Access is WAITLIST-GATED - we may not have API keys yet. Therefore: backend abstraction
  from day one: `real` (npm `@typesafe-ai/sdk`, pinned exactly at `0.6.0`) | `llm-adapter`
  (LLM answering in Jev wire format; Python reference: `typesafe-ai/system-one-adapter-python`)
  | `mock` (deterministic, for tests). Verify wire shapes against typesafe-sdk-js before
  writing the mock.
- Lane check (2026-09-18): zero jev/typesafe issues/PRs in upstream. LangChain shipped
  `langchain-typesafe` middleware (router + tool gating) - LangChain-locked, no benchmarks.

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
  `package.json`. **It is a HARDCODED file list, so a new test outside its paths never runs in the
  fast gate.** It runs the jev loop only: `packages/jev-core`, the `model-core`
  error-classifier tests, the four `event.model-fallback*` suites including the jev one,
  `packages/omo-opencode/src/features/jev`, `packages/omo-opencode/src/config/schema`,
  the two repo audits (`script/package-registration-audit.test.ts`,
  `script/shared-core-extraction-guard.test.ts`), and, added by W1, the six
  `packages/omo-opencode/src/plugin/*intent-routing*` suites plus `script/jev-w1-report.test.ts`.
  It is the mid-loop check, NOT a substitute for the full suite in final verification. Append to
  the list whenever a wire adds a test outside those directories.
- Known upstream debt at `v4.19.4`: `THIRD-PARTY-NOTICES.md` lacks headings for
  `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, and `zod`, so
  `node scripts/check-third-party-notices.mjs` is red at baseline; our gates are
  baseline-relative (no NEW missing entry). Not fixed in Phase A; mention in the
  upstream PR.
- License: Sustainable Use License (fair-code) - free non-commercial distribution OK,
  fork stays SUL. CLA on upstream PRs grants owner relicensing rights (accepted, known).

## Architecture cheat sheet (line numbers re-verified against v4.19.4 on 2026-09-22)
- Plugin entry/hooks: `packages/omo-opencode/src/plugin-interface.ts` - `tool`(37),
  `chat.params`(39), `chat.headers`(61), `command.execute.before`(63), `chat.message`(68),
  `experimental.chat.messages.transform`(75), `experimental.chat.system.transform`(79),
  `event`(86), `tool.definition`(94), `tool.execute.before`(98), `tool.execute.after`(104).
- ~57 sub-hooks, individually toggleable: `src/config/schema/hooks.ts` (`HookNameSchema`);
  assembly `src/create-hooks.ts:38-103`; `safeCreateHook` isolates crashes; `experimental`
  config block exists → ship everything default-off. Note: `create-hooks.ts` is NOT on the
  W4 path - model-error triage rides the `event` handler, not the hook registry, so W4
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
  (`omo-codex/.../quality-gate-verdicts.ts`) while opencode side regex-parses free text -
  "we're finishing a migration they started" (use in PR pitch).
- Heuristics are MULTILINGUAL (think-mode ~30 langs; Chinese error patterns in
  `model-core/src/model-error-classifier.ts:81-124`) - evals must cover this.
- Telemetry exists (posthog) - later: log decision outcomes to build eval sets.

## Wire plan (strict order; ONE PLAN PER WIRE)
**W4 - model-error triage** (first: small, provable, icebreaker PR)
- Now: substring lists → retry/stop/ignore: `packages/model-core/src/model-error-classifier.ts:9-188`
  (the five pattern lists through the end of `isRetryableModelError`; `shouldRetryError` is
  the thin export at `:194-196`). Consumer:
  `packages/omo-opencode/src/plugin/event-model-fallback.ts`, three seam sites now calling
  `jevTriage.shouldRetry(...)`, one per handler: `handleAssistantMessageUpdated` (site
  `message.updated`, around `:165`), `handleSessionStatus` (site `session.status`, around
  `:231`), and `handleSessionError` (site `session.error`, around `:292`). **Anchor on the
  handler names, not the line numbers** - those are indicative only and have already rotted
  twice as this file grew. Terminal-vs-transient:
  `packages/omo-opencode/src/features/background-agent/error-classifier.ts:133-160`.
- A SECOND classifier exists and is NOT covered by W4 yet:
  `packages/model-core/src/runtime-fallback-error-classifier.ts:47-144`
  (`classifyRuntimeFallbackError`), used by the reactive `runtime-fallback` system. It is a
  later W4 target. W4 is inert while `runtime_fallback` is on, because
  `shouldHandleModelFallback()` requires model fallback enabled AND runtime fallback off.
- Jev: `Choice[retry, stop, ignore]` + confidence over error name/message/status.
  Existing pattern lists become test fixtures/labels. Low confidence → current heuristic.

**W1 - intent gate + routing** (token headline). Status: **IMPLEMENTED OBSERVE-ONLY** on `jev/w1`.
- **Nothing is gated on a Jev answer, so no routing and no behavior changed.** The seam records
  what Jev would have predicted for a turn, records what the harness actually did, and writes both
  to a file. `chat.message` and `tool.execute.before` outputs stay byte-identical with the wire on
  or off, including when the backend throws, rejects, or times out. Phase 0 prose is NOT shrunk and
  no directive is injected; that is the later apply phase.
- **Phase 0 Intent Gate is SIX prose blocks, not one file.** The earlier reference
  `agents/sisyphus/default.ts:189-258` was wrong on both the count and the range. Re-derived
  against this branch on 2026-09-24, under `packages/omo-opencode/src/`:
  `agents/sisyphus-dynamic-prompt-role.ts:25-112`, `agents/sisyphus/claude-opus-5.ts:192-276`,
  `agents/sisyphus/claude-opus-4-8.ts:178-262`, `agents/sisyphus/claude-fable-5.ts:178-262`,
  `agents/sisyphus/claude-opus-4-7.ts:178-262`, `agents/sisyphus/default.ts:189-261`, plus the
  Hephaestus block `agents/hephaestus/gpt.ts:126-169`. Each runs roughly 890-1110 tokens inside a
  prefix-cached system prompt, so the apply-phase token headline is smaller than the one-file
  premise implied. Do not size that decision on the stale premise.
- Still accurate: category prose (`tools/delegate-task/tool-description.ts:48-87`); subagent tables
  (`agents/dynamic-agent-core-sections.ts:118-128`). Stage 2 category to model is already
  deterministic (`category-resolver.ts`, `delegate-core/model-selection.ts`): DO NOT TOUCH. Every
  path in these two bullets is a REFERENCE. W1 edits none of those files.
- Jev call: 4 questions per turn, dispatched once per eligible main-session prompt.
  `intent: Choice(6)`, `category: Choice(n+1)`, `subagent: Choice(15)`, `ambiguous: Noul`, with an
  explicit `none` option on every Choice. Targets are read from the live harness
  (`AvailableCategory` plus `INTENT_ROUTING_SUBAGENT_VOCABULARY`), and the vocabulary is hashed into
  each record so a roster change is detectable after the fact.
- Ground truth comes from `tool.execute.before` on `task` and `call_omo_agent`. These are
  delegation ATTEMPTS, not successes: the hook fires before the tool body, so guard-rejected and
  failed delegations are captured too. A `task` call carrying only `task_id` is a resume, which the
  harness never routed, so it is classified `unscorable_resume` rather than a spurious `none`.
- Sink: one JSONL file per process under `~/.omo/jev/`, named `w1-<YYYYMMDD>-<processId>.jsonl`,
  file mode 0600 inside a 0700 directory, hard-capped at 66 MiB with truncate-and-warn. Read it
  with `bun run script/jev-w1-report.ts --root ~/.omo/jev`. That report is a `script/` file, not a
  CLI subcommand: it has no `--help` surface and is deliberately absent from `src/cli/`.
- **Known representability limit: the live harness exposes a `general` subagent that the W1
  vocabulary cannot name.** `general` is in NEITHER `BuiltinAgentNameSchema` NOR
  `OverridableAgentNameSchema` (`packages/omo-opencode/src/config/schema/agent-names.ts`), so it is
  absent from `INTENT_ROUTING_SUBAGENT_VOCABULARY` too. A real delegation to `general` normalizes to
  `routeClass: "unknown"` and lands in the report's `unknown_only_records` bucket. This is a limit
  of the vocabulary, not a bug. The report keeps such a record in scoring and counts it as an
  unrepresentable mismatch rather than laundering it into the unscorable-resume bucket, because an
  unscorable resume means the harness made no choice while an unknown means it made one W1 cannot
  express. Widening the vocabulary to cover `general` is an apply-phase decision.

**W2 - completion/continuation gauntlet** (overnight-loop story)
- Now: `<promise>DONE</promise>` regex (`hooks/ralph-loop/constants.ts:3`,
  `completion-promise-detector.ts:32-34`); 14-condition gauntlet
  (`hooks/todo-continuation-enforcer/idle-event.ts:20-249`); stagnation counters
  (`stagnation-detection.ts:6-36`); boulder checkboxes (`boulder-state/src/plan-checklist.ts:5-16`).
- Jev: `actually_complete` / `progressing` / `stuck` Nouls over todo state + transcript
  tail + diff stat. Gates loop exit AND re-prompt injection.

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
- Phase A implemented on `jev/phase-a` (plan `.omo/plans/jev-phase-a.md`): DecisionBackend +
  mock/real/llm-adapter/disabled backends + config flags + `packages/jev-core/` + W4, merged
  `--no-ff` into `jev/foundation`.
- Current phase: **W1 implemented observe-only on `jev/w1`** (plan
  `.omo/plans/jev-w1-intent-routing.md`): the intent-routing question set, normalization,
  fixtures, turn store, capture, seal, JSONL sink, plugin wiring, and the agreement report. It
  measures; it does not route. Next is W2.

## Dogfood config
Two wires exist now, W4 and W1, and both are default-off. Put this in `~/.omo/omo.jsonc`
(the unified config; the `[opencode]` block is the plugin's).

W4 only:

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
        }
      }
    }
  }
}
```

W1 as well, observe-only. It writes JSONL to `~/.omo/jev/` and changes nothing else:

```jsonc
{
  "[opencode]": {
    "model_fallback": true,
    "jev": {
      "enabled": true,
      "backend": "real",
      "model": "jev-1.13.0",
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

Notes that bite in practice:
- `observe_only` is schema-only and has no runtime reader. It accepts `true` and REJECTS `false` at
  parse time, because acting on an intent-routing prediction lands with the apply phase.
- `intent_routing.timeout_ms` overrides the global `jev.timeout_ms` for this wire only. W1 sends 4
  questions where W4 sends 1, so tuning the global would move W4 with it.
- `turn_seal_timeout_ms` must be strictly greater than `timeout_ms` or the config is rejected. A
  turn that sealed on the prediction timeout would close before its first tool call.
- `confidence_threshold` only labels a record here. Unlike W4 it gates nothing.
- Pin an exact model id rather than the floating `jev-latest` if you want completed-prediction
  reuse; a floating alias disables reuse on purpose.
- Read the result with `bun run script/jev-w1-report.ts --root ~/.omo/jev`. Denominators print
  before any rate, and a corpus under 30 sealed records is labelled insufficient data instead of
  being presented as a result.

The API key never goes in the config. Export it:

```bash
export TYPESAFE_API_KEY=...
```

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
- 2026-09-24 W1 implementation pass on `jev/w1` (plan `.omo/plans/jev-w1-intent-routing.md`):
  - W1 marked IMPLEMENTED OBSERVE-ONLY, with the no-behavior-change property stated up front
    because the wire is easy to misread as a router. It observes and records; it routes nothing.
  - W1's stale prose reference corrected. `agents/sisyphus/default.ts:189-258` claimed one file and
    the wrong range. Phase 0 is SIX blocks plus a Hephaestus block, all seven listed in the W1
    section with re-derived ranges, and the token headline narrowed accordingly.
  - Added the `~/.omo/jev/` sink description (`w1-<YYYYMMDD>-<processId>.jsonl`, 0600 in a 0700
    directory, 66 MiB truncate-and-warn) and the `script/jev-w1-report.ts` reader. The reader is a
    `script/` file, not a CLI subcommand, and has no `--help` surface.
  - Recorded the `general` representability limit: the harness exposes a `general` subagent absent
    from both agent-name enums, so a real delegation to it normalizes to `unknown` and is counted
    as an unrepresentable mismatch rather than a routing failure.
  - Dogfood-config section split into a W4 block and a W4-plus-W1 block, with the per-key gotchas
    that actually bite: `observe_only` is schema-only and rejects `false`, the wire's `timeout_ms`
    shadows the global one, `turn_seal_timeout_ms` must exceed it, `confidence_threshold` only
    labels a record, and a floating model alias disables completed-prediction reuse.
  - `test:fast` extended with the seven new W1 test paths that sit outside the directories the
    hardcoded list already covers. Its documented scope under Repo state & git rules still holds:
    it is the mid-loop check, not a substitute for the full suite.
  - Em and en dashes removed from this file. A branch-wide gate greps every file in the diff, not
    only the changed lines, so pre-existing punctuation in a touched file fails it too.

## Dogfood log (mandatory)
`docs/jev/dogfood-log.md`. Every omo loop misbehavior observed while building this -
false `<promise>DONE</promise>`, zombie loop, stagnation miss, keyword false-trigger,
intent-gate misroute - gets one dated line + session context. These become W1/W2 test
cases and PR-pitch evidence.