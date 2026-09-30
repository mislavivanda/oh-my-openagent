# Task 19 Isolated OpenCode Dogfood

## WHAT WAS TESTED

`task-19-drive.sh` started one isolated long-lived `opencode serve`, a local scripted OpenAI Responses provider, and a local System One-compatible Jev endpoint. It replayed 32 turns through `opencode run --attach`, reused the first turn's session id for turns 2 through 32, and used a custom primary `jev-dogfood` agent that explicitly exposes `task` and `call_omo_agent`. A second fresh sandbox replayed the corpus with `jev.wires.intent_routing.enabled` false.

The enabled config used `backend: "real"`, a sandbox-only dummy `TYPESAFE_API_KEY`, local `OMO_JEV_BASE_URL`, and pinned model `jev-1.13.0`. The focused regression first failed because finalization removed the predecessor from the old completed map, then passed after completed predictions moved to an independently bounded session cache. The full JEV feature suite ran with ambient `HOME`, while every sink and reader received an explicit temporary root.

## WHAT WAS OBSERVED

The enabled sink contains 32 sealed observations and one `counter_delta`, all under session `ses_f0e673e3cffegHu3t2qguSkKGz`. Cohorts are zero 12, one 12, and many 8. One repeated prompt reused a finalized filled prediction. Three real `call_omo_agent` executions reached `tool.execute.before`; the structured turn 7 output is retained in `task-19-call-omo-agent-live.txt`. Three resume-only calls and two continuation candidates were recorded. All 32 correlations are reliable. Censored and overlap-ambiguous remain unreachable because each sequential CLI call reaches idle before the next prompt.

The report identity passes as `32 == 32 + 0 + 0`. Reuse avoided one dispatch, so 31 intent-routing log lines match 31 Jev requests. The disabled control completed 32 turns with zero intent-routing lines, zero Jev requests, and zero sink files.

The ambient-home JEV test run passed 85 tests and changed no entry under the existing empty `~/.omo/jev` directory. That directory was left in place. The refreshed real database count remained 426 before and after, and both fresh sandbox session ids are absent from the real database. Earlier real-DB and real-`~/.omo` deltas captured during the prior run were attributable to concurrent peer agents, not these sandbox session ids. The session-id absence is the direct non-leakage proof when peer activity changes shared host metadata.

Every spawned PID and bound port is listed in `task-19-receipts.txt`. Each CLI process exited zero, each server was terminated by its recorded PID, and each recorded port was released. No global process matcher was used.

## WHY IT IS ENOUGH

The evidence drives the production plugin through real OpenCode, one process-resident turn store, the real backend adapter against a local endpoint, and the real tool hook. It proves finalized prediction reuse, required cohorts, direct-agent capture, reporting identity, disabled gating, ambient-home test isolation, database isolation, and exact cleanup. Unit tests continue to cover `next_turn`, overlap marking, deferred finalization, floating aliases, and failed, timeout, not-dispatched, and evicted reuse exclusions.

## WHAT WAS OMITTED

Raw environment dumps, authentication headers, dummy key values, complete provider request bodies, and sandbox database files were omitted. Prompt text remains in the deterministic fixture. Server stdout and stderr remain in the external receipt directories for startup diagnosis but are not copied because they contain verbose request context.
