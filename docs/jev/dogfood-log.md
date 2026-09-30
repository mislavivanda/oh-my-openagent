# Jev dogfood log

Every omo loop misbehavior observed while building omo x jev gets one dated line here.
These entries become W1/W2 test cases and PR-pitch evidence, so record what actually
happened rather than what was expected.

Entry format:

`- YYYY-MM-DD | <category: false-done | zombie-loop | stagnation-miss | keyword-false-trigger | intent-misroute | delegation-failure | other> | <one-line observation> | session/context: <what was running>`

- 2026-09-19 | delegation-failure | explore, metis subagents fail at start with ProviderModelNotFoundError for opencode/gpt-5-nano (harness model misconfig, not an omo loop fault) | Prometheus planning session for jev-phase-a
- 2026-09-19 | zombie-loop | first explore delegation sat 30 minutes at the inactivity timeout before surfacing the model error; no early failure signal reached the parent | same session
- 2026-09-22 | other | no loop misbehavior observed during Phase A todos 1-13 | jev-phase-a execution
- 2026-09-24 | other | no loop misbehavior observed while extending the fast gate, regenerating schemas, and documenting W1 | jev-w1 Task 17 execution
- 2026-09-30 | zombie-loop | the project opencode-qa SSE self-test emitted only "Terminated" and blew past the 120000 ms tool timeout with no progress signal; a replacement probe that leaves HOME alone and isolates only the XDG roots reached a healthy server in under 5 seconds | jev-w2 todo 15 inertness and runtime-effects proof
- 2026-09-30 | other | Bun auto-loads `.env` and `.env.local`, so `env -u TYPESAFE_API_KEY` is silently undone and the plan's keyless "failure" command executed the full paid path for 18 real API calls; the in-process call budget could not see across `bun test` invocations, so a persistent on-disk baseline guard was added | jev-w2 todo 18 real-API baseline
- 2026-09-30 | stagnation-miss | measured against real `jev-1.13.0`, the W2 `progressing` Noul decided only 2 of 15 known-label fixtures correctly and put every true-progressing fixture in the uncertain band, so the signal cannot currently tell a working loop from a stalled one; `stuck` was middling at 8 of 15 | jev-w2 todo 18 real-API baseline
- 2026-09-30 | false-done | on the two fixtures whose completion truth is deliberately unknowable from the state, real `jev-1.13.0` answered `actually_complete` as a confident `would_false` instead of staying uncertain, which is a calibration problem to carry into question design | jev-w2 todo 18 real-API baseline
- 2026-09-30 | other | the hardcoded `test:fast` target list never covered `packages/omo-opencode/src/hooks/todo-continuation-enforcer`, so the 157 W2 wiring, outcome, idle-characterization, inert, hook-construction, shared-matcher, and report tests added by todos 9 through 16 never ran in the mid-loop gate; the gate reported green at 621 tests while silently skipping them | jev-w2 todo 17 documentation and fast-gate pass
