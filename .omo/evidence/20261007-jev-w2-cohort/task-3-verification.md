# Todo 3 Verification

## WHAT WAS TESTED

The production OpenCode plugin was driven through one isolated long-lived `opencode serve` per cohort, with a local fake Responses provider and local fake Jev endpoint. `--drive autonomous` sent one initial user prompt, then allowed `todo-continuation-enforcer` to inject synthetic internal continuation prompts. `--drive interactive` retained the original 29 `opencode run --attach` user turns. A separate autonomous sandbox ran with the W2 wire disabled.

The driver polled all three HTTP health endpoints, kept receipts outside each sandbox, compared the real OpenCode database count and real `~/.omo` manifest before and after, queried every driven session id in the real database, and terminated only recorded PIDs. Root `bun run typecheck` and `bun run build` were also run. An assertion was deliberately made false to prove a nonzero driver exit, then reverted byte-exactly.

## WHAT WAS OBSERVED

Autonomous mode produced 28 long-lived-session records: 27 `tracked_work_progressed` observed closures and one `session_deleted` censor, for 27/28 observed coverage (96.43%). Interactive mode reproduced the before-state population exactly: 31 records split into 5 observed and 26 censored, including 23 `human_intervention`, 2 `timeout`, and 1 `session_deleted`. Its observed coverage remained 5/31 (16.13%). The cohorts therefore differ by actual user-message timing, not labels.

The autonomous disabled control wrote zero W2 files. Every run kept the real database count at 557, and all three driven session ids had zero rows in the real database. The real `~/.omo` manifest had zero changes after the named ambient heartbeat exclusions, and real `~/.omo/jev` remained absent. Across enabled autonomous, enabled interactive, and disabled control runs, 556 of 556 receipt PIDs were dead and all 9 ports were closed when checked individually.

The deliberate assertion failure exited 1 and planted its propagation sentinel. Its one recorded PID was killed by exact PID and its one recorded port was then closed. The driver checksum was `7ceb7ae079597a84f3bf871966bb592f75f6878a36a56626244e356070f27146` both before and after revert. The forbidden process-matcher grep returned exit 1, zero matching lines, and empty stdout. Typecheck and build both exited 0.

## WHY IT IS ENOUGH

The autonomous successor idles come from the real continuation hook: the fake model advances one tracked todo state per synthetic internal prompt, and its response latency crosses the hook's 5-second cooldown before the next idle. No user message is inserted between predecessor and successor. The 96.43% observed result materially exceeds the 5/31 before-state, while the unchanged interactive result proves that `human_intervention` censoring remains intact. Disabled gating, host isolation, exact process cleanup, assertion propagation, static checks, typecheck, and build cover the retained acceptance properties.

## WHAT WAS OMITTED

Raw provider request bodies, auth headers, environment dumps, sandbox databases, verbose OpenCode logs, and the fixed dummy key were not copied. Full external receipts remain under `/tmp/opencode/jev-w2c-{auto,interactive,disabled}-receipts`. No real provider API was armed or called.
