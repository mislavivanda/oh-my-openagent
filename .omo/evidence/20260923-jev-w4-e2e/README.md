# Jev W4 real-session real-API E2E

## Scope of this evidence

This record was trimmed after capture. The raw per-scenario SSE event dumps (`scenario-*-events.jsonl`) and the raw structured logs (`scenario-*-jev.log`) were intentionally dropped to keep the record small; the decisions they contained are already captured in the retained `scenario-*-jev.json`/`.jsonl` files below. The provider error messages used to drive each scenario were **synthetic**, authored for this test, not observed in production. The retained `scenario-*-jev.json*` files are the intended **regression baseline** for re-running the matrix after a Jev model-version bump: `model: "jev-latest"` floats and resolved to `jev-1.13.0` during these runs, and a future bump can change decisions silently without this baseline to diff against.

## What was tested

OpenCode 1.18.32 loaded the source plugin in six separate isolated HOME/XDG/TMP sandboxes. Each scenario used an authenticated `opencode serve` session, a global SSE observer, and one parameterized local fake OpenAI provider response. W4 was enabled with `backend: "real"`; the Jev credential existed only in process environments. The control returned a valid streamed 200 response. Scenarios 1 through 5 returned the requested error status and message.

The heuristic was executed directly from `packages/omo-opencode/src/shared/model-error-classifier` with the name/message shape observed at the seam. Phase A does not thread HTTP status into W4, so status was intentionally omitted from the direct classifier input.

## Result matrix

| Scenario | Provider response | Direct heuristic | Jev choice and confidence | Agreement | W4 status |
|---|---|---:|---|---|---|
| 0 | 200 success | n/a | no call, zero `[jev]` lines | n/a | seam not reached |
| 1 | 429 rate limit | `true` | `retry`, 0.99 | agree | `applied` |
| 2 | 429 monthly quota | `false` | `stop`, 1.00 | agree | `applied` |
| 3 | 401 permission denied | `false` | **not retained**: the session emitted two Jev lines before teardown and the original exact-one assertion aborted before copying them | **unknown** | **unknown** |
| 4 | 503 unavailable | `true` | `retry`, 1.00 | agree | `applied` |
| 5a | 400 context length, `session.error` | `false` | `ignore`, 1.00 | agree | `applied` |
| 5b | same session, first `message.updated` | `false` | `ignore`, 0.99 | agree | `applied` |
| 5c | same session, second `message.updated` | `false` | `ignore`, 0.99 | agree | `applied` |

The user's heuristic expectations were empirically correct for all five error messages. The 429 monthly-quota case remained `false` because the stop-message pattern takes precedence. The requested status codes did not influence the heuristic because production W4 currently receives only name/message.

## Premise answers

1. **Yes, the real API was called from real OpenCode sessions.** Every retained decision line has `"backend":"real"`, and the lines came from the source plugin loaded by the isolated OpenCode servers.
2. **Yes, the applied path fired.** All six retained decisions were `status:"applied"` with confidence at or above 0.99. None fell through.
3. **No retained Jev decision disagreed with the heuristic.** The four fully captured error scenarios produced six agreements and zero divergences. A stronger all-matrix claim is not possible: scenario 3 was driven and made two real calls, but its lines were lost when the first-run harness rejected the duplicate count before copying the sandbox log. It was not rerun because the test instructions prohibit retrying paid API scenarios.
4. **Retained decision latency was 159.679-229.843 ms.** The six retained calls were 159.679, 193.410, 229.843, 182.941, 190.182, and 166.856 ms. The test made **8 real Jev calls total**, not the intended 5: scenarios 1, 2, and 4 made one each; scenario 3 made two; scenario 5 made three. The harness initiated no Jev retry. Multiple OpenCode lifecycle sites independently invoked the seam for one provider failure.
5. **Surprise versus `real-backend.ts`:** the backend's `maxRetries: 0` guarantee held per decision, but it does not imply one paid decision per provider error. A single 400 generated decisions at `session.error` and twice at `message.updated`; the 401 generated two lines before teardown. This is a cost/duplication issue above `real-backend.ts`. Also, all production states still had `status_code:null`, matching the documented Phase A limitation despite the fake provider's concrete statuses.

## Detailed retained decisions

- Scenario 1: site `session.status`; probabilities `ignore=0, stop=0, retry=1`; reason `null`; final `shouldRetry=true`.
- Scenario 2: site `session.status`; probabilities `retry=0, stop=1, ignore=0`; reason `null`; final `shouldRetry=false`.
- Scenario 4: site `session.status`; probabilities `retry=1, ignore=0, stop=0`; reason `null`; final `shouldRetry=true`.
- Scenario 5a: site `session.error`; probabilities `retry=0, ignore=1, stop=0`; reason `null`; final `shouldRetry=false`.
- Scenario 5b: site `message.updated`; probabilities `stop=0, ignore=0.99, retry=0.01`; reason `null`; final `shouldRetry=false`.
- Scenario 5c: site `message.updated`; probabilities `stop=0, retry=0, ignore=1`; reason `null`; final `shouldRetry=false`.

Parsed decision records for every retained scenario are in `scenario-*-jev.json` (scenarios 1-2) and `scenario-*-jev.jsonl` (scenarios 3-11). Raw structured logs (`scenario-*-jev.log`) and raw SSE event captures (`scenario-*-events.jsonl`) were dropped per the scope note above; scenario 0 produced no Jev lines and has no decision file.

## Isolation and omissions

The real database was opened only with read-only SQLite and remained at 330 sessions before and after. Sandboxes used free ports and cleanup targeted only child PIDs created by the harness; the user's port 4096 server was not touched. Raw server logs, credentials, auth headers, sandbox roots, and the unretained scenario 3 duplicate lines were omitted. The credential was never interpolated into configuration or retained output.

## Why this evidence is enough, and what remains unresolved

The control proves the seam stays dormant on success. The real-backend markers, applied statuses, complete decision fields, direct heuristic checks, SSE lifecycle captures, and unchanged host DB jointly prove the requested real-session-to-real-API path for the captured scenarios. The evidence also disproves the assumption that one provider error necessarily costs one Jev call.

It does **not** settle whether Jev disagrees on the 401 permission case. That row remains explicitly unresolved rather than being replaced with the standalone live probe or a mock result.
