#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

: "${EVIDENCE_DIR:?EVIDENCE_DIR must be set}"

for b in opencode jq curl sqlite3 bun timeout; do
  command -v "$b" >/dev/null || fail "missing: $b"
done

REPO_ROOT="$PWD"
COMMON_SH="$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
SUMMARY="$EVIDENCE_DIR/task-15-load-smoke.txt"
[ -f "$COMMON_SH" ] || fail "opencode-qa common.sh not found"
mkdir -p "$EVIDENCE_DIR"
: > "$SUMMARY"

REAL_HOME="$HOME"
REAL_DB="$(opencode db path)"
test -f "$REAL_DB" || fail "real DB not found; refusing to run because sqlite3 would create it"
BEFORE=$(sqlite3 -readonly "$REAL_DB" "SELECT count(*) FROM session")
case "$REAL_DB" in
  "$REAL_HOME"/*) printf 'real_db=%s\n' "\$HOME${REAL_DB#"$REAL_HOME"}" >> "$SUMMARY" ;;
  *) printf 'real_db=<outside-home>/%s\n' "$(basename "$REAL_DB")" >> "$SUMMARY" ;;
esac
printf 'surface=opencode-server+sse\n' >> "$SUMMARY"
printf 'db_sessions_before=%s\n' "$BEFORE" >> "$SUMMARY"

for MODE in enabled disabled; do
  (
    # shellcheck source=/dev/null
    source "$COMMON_SH"
    trap 'for pid in "${SSE_PID:-}" "${SERVER_PID:-}" "${FAKE_PID:-}"; do if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi; done; oqa_cleanup' EXIT

    oqa_mk_isolated_xdg || fail "$MODE: could not create isolated XDG sandbox"
    export TMPDIR="$XDG_STATE_HOME/tmp"
    mkdir -p "$TMPDIR" "$HOME/.omo" "$XDG_CONFIG_HOME/opencode"
    unset TYPESAFE_API_KEY

    export FAKE_PORT
    FAKE_PORT=$(oqa_free_port)
    export FAKE_LOG="$XDG_STATE_HOME/fake-provider.log"
    : > "$FAKE_LOG"
    FAKE_PORT="$FAKE_PORT" FAKE_LOG="$FAKE_LOG" bun -e 'import { appendFileSync } from "node:fs"; Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.FAKE_PORT), fetch: (req) => { appendFileSync(process.env.FAKE_LOG, `${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname}\n`); return new Response(JSON.stringify({ error: { message: "rate limit exceeded, please retry later", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } }) } })' &
    FAKE_PID=$!
    oqa_wait_http "http://127.0.0.1:$FAKE_PORT/" "" 10 || fail "$MODE: fake provider never came up"
    P0_BASE=$(wc -l < "$FAKE_LOG")

    cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-key",
        "baseURL": "http://127.0.0.1:${FAKE_PORT}/v1",
        "timeout": 5000
      },
      "models": {
        "gpt-fake": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  },
  "permission": { "bash": "allow", "call_omo_agent": "allow" }
}
JSONC

    if [ "$MODE" = "enabled" ]; then
      MODE_BOOL=true
    else
      MODE_BOOL=false
    fi
    cat > "$HOME/.omo/omo.jsonc" <<JSONC
{
  "[opencode]": {
    "model_fallback": true,
    "jev": {
      "enabled": ${MODE_BOOL},
      "backend": "mock",
      "wires": { "model_error_triage": { "enabled": ${MODE_BOOL} } }
    }
  }
}
JSONC
    cat > "$XDG_CONFIG_HOME/opencode/oh-my-openagent.json" <<JSON
{
  "model_fallback": true,
  "jev": {
    "enabled": ${MODE_BOOL},
    "backend": "mock",
    "wires": { "model_error_triage": { "enabled": ${MODE_BOOL} } }
  }
}
JSON

    SERVER_PORT=$(oqa_free_port)
    SERVER_PASS="task15-$MODE"
    SERVER_URL="http://127.0.0.1:$SERVER_PORT"
    SERVER_OUT="$XDG_STATE_HOME/opencode-server.out"
    SERVER_ERR="$XDG_STATE_HOME/opencode-server.err"
    OPENCODE_SERVER_PASSWORD="$SERVER_PASS" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG > "$SERVER_OUT" 2> "$SERVER_ERR" &
    SERVER_PID=$!

    SERVER_READY=false
    for _ in $(seq 1 60); do
      if curl --max-time 1 -fsS -u "opencode:$SERVER_PASS" "$SERVER_URL/global/health" >/dev/null 2>&1; then
        SERVER_READY=true
        break
      fi
      sleep 0.5
    done
    [ "$SERVER_READY" = true ] || fail "$MODE: opencode server never became healthy"

    EVENTS_RAW="$XDG_STATE_HOME/events.sse"
    timeout 90 curl -NsS -u "opencode:$SERVER_PASS" "$SERVER_URL/global/event" > "$EVENTS_RAW" &
    SSE_PID=$!
    sleep 1

    ENCODED_DIR=$(jq -rn --arg value "$OQA_PROJ" '$value|@uri')
    SESSION_RESPONSE=$(curl --max-time 15 -fsS -u "opencode:$SERVER_PASS" -X POST "$SERVER_URL/session?directory=$ENCODED_DIR" -H 'content-type: application/json' -d "{\"title\":\"Todo 15 $MODE smoke\"}")
    SESSION_ID=$(printf '%s' "$SESSION_RESPONSE" | jq -r '.id // .sessionID // empty')
    [ -n "$SESSION_ID" ] || fail "$MODE: server did not create a session"
    PROMPT_HTTP=$(curl --max-time 15 -sS -o "$XDG_STATE_HOME/prompt-response.txt" -w '%{http_code}' -u "opencode:$SERVER_PASS" -X POST "$SERVER_URL/session/$SESSION_ID/prompt_async?directory=$ENCODED_DIR" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"say hi"}]}')
    [ "$PROMPT_HTTP" = 204 ] || fail "$MODE: prompt_async returned HTTP $PROMPT_HTTP"

    LOG=""
    for _ in $(seq 1 60); do
      LOG=$(ls "$TMPDIR"/oh-my-open*.log 2>/dev/null | head -1 || true)
      HITS=$(wc -l < "$FAKE_LOG")
      if [ -n "$LOG" ] && [ -f "$LOG" ]; then
        P1=$(grep -c "ENTRY - plugin loading" "$LOG" || true)
        P2=$(grep -c "\[model-fallback\]" "$LOG" || true)
        JEV_LINES=$(grep -c "\[jev\] model-error-triage" "$LOG" || true)
        RETRY_EVENTS=$(grep -c '"type":"session.status".*"status":{"type":"retry"' "$EVENTS_RAW" || true)
        if [ "$HITS" -gt "$P0_BASE" ] && [ "$P1" -ge 1 ] && [ "$P2" -ge 1 ] && [ "$RETRY_EVENTS" -ge 1 ]; then
          if [ "$MODE" = "disabled" ] || [ "$JEV_LINES" -ge 1 ]; then
            break
          fi
        fi
      fi
      sleep 1
    done
    sleep 2

    [ -n "$LOG" ] && [ -f "$LOG" ] || fail "$MODE: plugin log not found under TMPDIR"
    HITS=$(wc -l < "$FAKE_LOG")
    [ "$HITS" -gt "$P0_BASE" ] || fail "$MODE P0: server prompt never reached the fake provider (hits=$HITS base=$P0_BASE)"
    P1=$(grep -c "ENTRY - plugin loading" "$LOG" || true)
    [ "$P1" -ge 1 ] || fail "$MODE P1: plugin source entry did not load"
    RETRY_EVENTS=$(grep -c '"type":"session.status".*"status":{"type":"retry"' "$EVENTS_RAW" || true)
    [ "$RETRY_EVENTS" -ge 1 ] || fail "$MODE: SSE never exposed the retry lifecycle event"
    P2=$(grep -c "\[model-fallback\]" "$LOG" || true)
    [ "$P2" -ge 1 ] || fail "$MODE P2: model-fallback path did not log"

    RUN_OUTPUT="$EVIDENCE_DIR/task-15-run-$MODE.jsonl"
    grep '^data: {' "$EVENTS_RAW" | cut -c7- | jq -c '.payload // .' | sed -e "s|$REPO_ROOT|<repo-root>|g" -e "s|$OQA_XDG_ROOT|<sandbox>|g" > "$RUN_OUTPUT"
    [ -s "$RUN_OUTPUT" ] || fail "$MODE: SSE JSONL evidence is empty"

    JEV_OUTPUT="$EVIDENCE_DIR/task-15-jev-log-$MODE.txt"
    : > "$JEV_OUTPUT"
    JEV_LINES=$(grep -c "\[jev\] model-error-triage" "$LOG" || true)
    if [ "$JEV_LINES" -ge 1 ]; then
      grep '\[jev\] model-error-triage' "$LOG" >> "$JEV_OUTPUT"
    fi

    if [ "$MODE" = "enabled" ]; then
      [ "$JEV_LINES" -ge 1 ] || fail "enabled P3: no Jev model-error-triage line"
      INVALID_BACKEND=$(grep '\[jev\] model-error-triage' "$LOG" | grep -vc '"backend":"mock"' || true)
      INVALID_STATUS=$(grep '\[jev\] model-error-triage' "$LOG" | grep -vc 'fell_through' || true)
      INVALID_REASON=$(grep '\[jev\] model-error-triage' "$LOG" | grep -vc 'unscripted' || true)
      [ "$INVALID_BACKEND" -eq 0 ] || fail "enabled P3: a Jev line did not use mock backend"
      [ "$INVALID_STATUS" -eq 0 ] || fail "enabled P3: a Jev line did not fall through"
      [ "$INVALID_REASON" -eq 0 ] || fail "enabled P3: a Jev line was not unscripted"
      ALL_LINES_VALID=true
    else
      [ "$JEV_LINES" -eq 0 ] || fail "disabled P3: expected zero Jev lines, got $JEV_LINES"
    fi

    UNCAUGHT_LOG=$(grep -c "Uncaught" "$LOG" || true)
    UNCAUGHT_SERVER=$(grep -c "Uncaught" "$SERVER_ERR" || true)
    UNCAUGHT=$((UNCAUGHT_LOG + UNCAUGHT_SERVER))
    [ "$UNCAUGHT" -eq 0 ] || fail "$MODE: uncaught exception observed"

    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
    SSE_PID=""
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    kill "$FAKE_PID" 2>/dev/null || true
    wait "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""

    AFTER=$(sqlite3 -readonly "$REAL_DB" "SELECT count(*) FROM session")
    [ "$BEFORE" = "$AFTER" ] || fail "$MODE: real DB session count changed (before=$BEFORE after=$AFTER)"

    if [ "$MODE" = "enabled" ]; then
      printf 'enabled: P0=pass P1=pass P2=pass jev_lines=%s all_lines_mock_fell_through_unscripted=%s uncaught=%s\n' "$JEV_LINES" "$ALL_LINES_VALID" "$UNCAUGHT" >> "$SUMMARY"
    else
      printf 'disabled: P0=pass P1=pass P2=pass jev_lines=%s uncaught=%s\n' "$JEV_LINES" "$UNCAUGHT" >> "$SUMMARY"
    fi
  )
done

AFTER=$(sqlite3 -readonly "$REAL_DB" "SELECT count(*) FROM session")
[ "$BEFORE" = "$AFTER" ] || fail "real DB session count changed after both modes (before=$BEFORE after=$AFTER)"
printf 'db_sessions_before=%s after=%s\n' "$BEFORE" "$AFTER" >> "$SUMMARY"
printf 'PASS: Todo 15 real-harness load smoke via server+SSE\n'
