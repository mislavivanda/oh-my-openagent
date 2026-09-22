# Jev dogfood log

Every omo loop misbehavior observed while building omo x jev gets one dated line here.
These entries become W1/W2 test cases and PR-pitch evidence, so record what actually
happened rather than what was expected.

Entry format:

`- YYYY-MM-DD | <category: false-done | zombie-loop | stagnation-miss | keyword-false-trigger | intent-misroute | delegation-failure | other> | <one-line observation> | session/context: <what was running>`

- 2026-09-19 | delegation-failure | explore, metis subagents fail at start with ProviderModelNotFoundError for opencode/gpt-5-nano (harness model misconfig, not an omo loop fault) | Prometheus planning session for jev-phase-a
- 2026-09-19 | zombie-loop | first explore delegation sat 30 minutes at the inactivity timeout before surfacing the model error; no early failure signal reached the parent | same session
