# Jev dogfood log

Every omo loop misbehavior observed while building omo x jev gets one dated line here.
These entries become W1/W2 test cases and PR-pitch evidence, so record what actually
happened rather than what was expected.

Entry format:

`- YYYY-MM-DD | <category: false-done | zombie-loop | stagnation-miss | keyword-false-trigger | intent-misroute | delegation-failure | other> | <one-line observation> | session/context: <what was running>`

- 2026-09-19 | delegation-failure | explore, metis subagents fail at start with ProviderModelNotFoundError for opencode/gpt-5-nano (harness model misconfig, not an omo loop fault) | Prometheus planning session for jev-phase-a
- 2026-09-19 | zombie-loop | first explore delegation sat 30 minutes at the inactivity timeout before surfacing the model error; no early failure signal reached the parent | same session
- 2026-09-22 | other | no loop misbehavior observed during Phase A todos 1-13 | jev-phase-a execution
- 2026-09-24 | other | the W1 sink test wrote into the operator's real `~/.omo/jev-tests` on every plain `bun test` run, because it defaulted to the real home directory instead of injecting a temp dir; caught only by inspecting the real home after a full-suite run, and fixed by making the test self-isolating | jev-w1 execution, sink todo
- 2026-09-24 | other | `lsp_diagnostics` is non-functional in this environment, the shared LSP daemon binary is missing from its cached package path, so every diagnostics call fails and type checking has to go through `bun run typecheck` instead | jev-w1 execution, all todos
