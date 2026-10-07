# Todo 6 Final Integrated-State Measurement

## WHAT WAS TESTED

The final `jev/w2-cohort` state containing commits `a9c3dc6ad`, `468268b5e`,
`616604d41`, and `ed4d08d56` was driven through the real OpenCode plugin with
the local fake model and local fake Jev endpoint. The existing task-19 driver ran
once with `--drive autonomous` and once with `--drive interactive`. Each run used
its own sandbox and receipts directory under `/tmp/opencode/`.

Before each dogfood run, Bun printed `JEV_W2_REAL_API=UNSET` and
`JEV_W2_REAL_API_REARM=UNSET`; the wrapper would have exited before the driver if
either value was present. No real API was armed or called.

The main session IDs from the driver summaries were used to form two report
corpora. The autonomous corpus contains exactly 28 rows and the interactive
corpus exactly 31 rows, with zero foreign-session rows in either corpus. This
keeps the eviction-pressure fixture out of the agreement comparison while
retaining its raw driver assertions. Both main-session corpora were passed to
`script/jev-w2-report.ts` from todo 2.

## WHAT WAS OBSERVED

### Driver-level closure coverage

- Autonomous: 27 observed of 28 main-session records, or 96.43%. The closure
  partition is 27 `tracked_work_progressed` and 1 `session_deleted`.
- Interactive: 5 observed of 31 main-session records, or 16.13%. The partition
  is 23 `human_intervention`, 2 `timeout`, 1 `session_deleted`, and 5 observed.

The autonomous result equals todo 3's 27 of 28 rather than falling below it. It
is 22 more observed records and 80.30 percentage points above the documented
before-state of 5 of 31. The interactive result exactly reproduces 5 of 31.

### Report-rendered cohort blocks, verbatim

Autonomous-drive main session:

```text
outcome_cohort_autonomous: 27
outcome_cohort_human_interactive: 0
OUTCOME COHORT autonomous
actually_complete cohort=autonomous overall: 21/27 (77.78%); coverage=27/27
progressing cohort=autonomous overall: 7/27 (25.93%); coverage=27/27
stuck cohort=autonomous overall: 20/27 (74.07%); coverage=27/27
OUTCOME COHORT human_interactive
actually_complete cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/0
progressing cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/0
stuck cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/0
```

Interactive-drive main session:

```text
outcome_cohort_autonomous: 5
outcome_cohort_human_interactive: 23
OUTCOME COHORT autonomous
actually_complete cohort=autonomous overall: 2/4 (50.00%); coverage=4/5
progressing cohort=autonomous overall: 2/4 (50.00%); coverage=4/5
stuck cohort=autonomous overall: 2/4 (50.00%); coverage=4/5
OUTCOME COHORT human_interactive
actually_complete cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/23
progressing cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/23
stuck cohort=human_interactive overall: insufficient data (eligible denominator=0); coverage=0/23
```

The report therefore gives the autonomous-drive cohort a 27/27 eligible
coverage denominator for all three questions. In the interactive drive, the five
observed records are correctly stratified into the autonomous outcome cohort;
one has no filled prediction, so each question renders 4/5 coverage. The 23
human-intervention closures form the human-interactive cohort and render 0/23
coverage because censored records never enter an outcome-agreement denominator.
This explains why the old pooled 5-of-31 figure must not be presented as coverage
of the human-interactive cohort.

### W2 inertness and runtime effects

The inertness suite passed 2/2 and the runtime-effects suite passed 3/3. All six
anti-vacuity perturbations fired:

```text
ANTI_VACUITY_PROMPT_BYTE=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_COUNTDOWN_DELAY=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_SIDE_EFFECT_ORDER=FAIL_DETECTED existing trace byte mismatch
ANTI_VACUITY_W2_OWNED_INJECTION=FAIL_DETECTED W2-owned effect leaked into Part A: backend_call
ANTI_VACUITY_UNREF_HANDLE=FAIL_DETECTED W2 handle unref audit failed: missing_or_duplicate=1
ANTI_VACUITY_UNREF_CHILD=FAIL_DETECTED timed_out=true
```

The corresponding normal paths printed
`ANTI_VACUITY_PART_A_REVERT=PASS`,
`ANTI_VACUITY_UNREF_HANDLE_REVERT=PASS`, and
`ANTI_VACUITY_UNREF_CHILD_REVERT=PASS`.

### Verification gates

- `bun run typecheck`: exit 0.
- `bun run build`: exit 0 and `build: all steps completed`.
- `bun run test:fast`: 799 pass, 0 fail, 2470 assertions across 93 files.
- Full suite in a no-env-file process: expected exit 1, exactly 7 failing
  identities, and duration-stripped identity diff exit 0 with 0 matching diff
  lines. The plan-named `task-1-full-suite-failures.txt` alias is absent from the
  evidence tree; the comparison uses the canonical seven-line artifact
  `F2R-full-suite-failures.txt`, whose companion identity-comparison evidence
  explicitly documents that naming correction.
- The first full-suite attempt inherited `OPENCODE_SERVER_PASSWORD` from `.env`
  and honestly exposed 14 additional tmux assertion identities because the
  password adds `-e OPENCODE_SERVER_PASSWORD=...` arguments. The accepted gate
  used `bun --no-env-file` and verified the password and both real-API controls
  were unset inside Bun before running. This reproduced exactly the canonical
  seven identities.
- Exact-PID cleanup checked 551 receipt PIDs and exact-port cleanup checked 6
  ports. Alive and open matching-line counts were both zero.
- `lsp_diagnostics` was invoked after starting the built worktree daemon by an
  exact tracked PID. Every changed file is evidence with a `.md`, `.txt`, or
  `.tsv` extension, and the tool reports that no LSP server is configured for
  those extensions. No source file or diagnostic-bearing extension was changed.

## KNOWN REAL-API STALENESS

Question version 3 changed only `progressing`: its serialized text changed from
1495 to 1735 bytes and six fixture labels changed. `actually_complete` remains
byte-identical at 416 bytes with SHA-256 prefix `071debc6939e5a35`.
`stuck` remains byte-identical at 1550 bytes with prefix
`fccb99d69acfeaa2`. Therefore the paid v2 results remain valid for
`actually_complete` (15/16) and `stuck` (9/15). The paid `progressing` results,
4 of 18 clearing the 0.80 bar and 6 of 15 correct, are stale under v3. No attempt
was made to re-measure `progressing` against a real API.

## WHY IT IS ENOUGH

The two fresh real-harness runs exercise both drive modes after all four prior
todos landed. Report output supplies the cohort numbers rather than a manual
calculation. Main-session filtering prevents pressure-fixture teardown records
from changing the population being compared with the documented 31-record
before-state. The unchanged interactive partition proves human intervention,
timeout, and deletion remain censored. The inertness trace and runtime probes
re-prove observe-only zero-behavior-change, and the full gate set covers types,
build output, focused behavior, repository-wide failure identity, cleanup, and
file hygiene.

## WHAT WAS OMITTED

Raw provider request bodies, auth headers, environment dumps, sandbox databases,
verbose OpenCode logs, the fixed dummy credential, and the full 500-plus-record
stress corpus were not copied into committed evidence. They remain in the named
`/tmp/opencode/jev-w2c-task6-*` sandboxes and receipts during review. No source
file owned by another todo was edited.

## DoneClaim

```json
{"kind":"DoneClaim","todo":6,"status":"complete","autonomous_driver_coverage":"27/28","autonomous_report_coverage":"27/27","interactive_driver_coverage":"5/31","human_interactive_report_coverage":"0/23","inertness":"unchanged","anti_vacuity_probes":6,"real_api_calls":0}
```
