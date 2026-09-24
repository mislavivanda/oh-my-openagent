# Jev dogfood log

Every omo loop misbehavior observed while building omo x jev gets one dated line here.
These entries become W1/W2 test cases and PR-pitch evidence, so record what actually
happened rather than what was expected.

Entry format:

`- YYYY-MM-DD | <category: false-done | zombie-loop | stagnation-miss | keyword-false-trigger | intent-misroute | delegation-failure | other> | <one-line observation> | session/context: <what was running>`

- 2026-09-19 | delegation-failure | explore, metis subagents fail at start with ProviderModelNotFoundError for opencode/gpt-5-nano (harness model misconfig, not an omo loop fault) | Prometheus planning session for jev-phase-a
- 2026-09-19 | zombie-loop | first explore delegation sat 30 minutes at the inactivity timeout before surfacing the model error; no early failure signal reached the parent | same session
- 2026-09-22 | other | no loop misbehavior observed during Phase A todos 1-13 | jev-phase-a execution
- 2026-09-24 | other | the LSP daemon was unreachable for every diagnostics call because the workspace TypeScript 7.0.2 ships no tsserver.js, so every type check across the run fell back to a scoped tsgo invocation instead of live diagnostics | session/context: jev/w1-fffe execution, first hit at todo 2 and unchanged through todo 17
- 2026-09-24 | other | the plan's own two-schema negative proof was written in a direction that cannot hold: script/build-schema.ts writes assets/omo.schema.json, assets/oh-my-opencode.schema.json, and dist/oh-my-opencode.schema.json, while script/build-omo-schema.ts writes only assets/omo.schema.json, so build:schema alone already refreshes both assets and the reverse staleness the proof asked for cannot occur | session/context: jev/w1-fffe todo 17, verified by reading both script files and by re-running both builds to a zero git diff
