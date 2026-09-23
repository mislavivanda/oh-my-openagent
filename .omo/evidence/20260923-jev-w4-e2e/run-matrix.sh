#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

: "${EVIDENCE_DIR:?EVIDENCE_DIR must be set}"
REPO_ROOT="$PWD"
COMMON_SH="$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
[ -f "$COMMON_SH" ] || fail "opencode-qa common.sh not found"

for command_name in opencode jq curl sqlite3 bun timeout; do
  command -v "$command_name" >/dev/null || fail "missing command: $command_name"
done

set -a
# shellcheck source=/dev/null
source "$REPO_ROOT/.env.local" >/dev/null 2>&1
set +a
: "${TYPESAFE_API_KEY:?TYPESAFE_API_KEY is missing}"

mkdir -p "$EVIDENCE_DIR"
SUMMARY="$EVIDENCE_DIR/run-summary.txt"
HEURISTICS="$EVIDENCE_DIR/heuristics.jsonl"
if [ "${RESUME:-0}" != 1 ]; then
  : > "$SUMMARY"
  : > "$HEURISTICS"
fi

REAL_HOME="$HOME"
REAL_DB="$(opencode db path)"
[ -f "$REAL_DB" ] || fail "real DB not found"
DB_BEFORE="$(sqlite3 -readonly "$REAL_DB" 'SELECT count(*) FROM session')"
if [ "${RESUME:-0}" != 1 ]; then
  printf 'surface=opencode-serve+global-sse\n' >> "$SUMMARY"
  printf 'opencode_version=%s\n' "$(opencode --version)" >> "$SUMMARY"
  printf 'db_sessions_before=%s\n' "$DB_BEFORE" >> "$SUMMARY"
fi

scenario_status() {
  case "$1" in
    0) printf '200' ;;
    1|2) printf '429' ;;
    3) printf '401' ;;
    4) printf '503' ;;
    5) printf '400' ;;
    6|7) printf '502' ;;
    8|9) printf '500' ;;
    10) printf '400' ;;
    11) printf '403' ;;
  esac
}

scenario_message() {
  case "$1" in
    0) printf 'control success' ;;
    1) printf 'rate limit exceeded, please retry later' ;;
    2) printf 'quota exceeded for this month' ;;
    3) printf 'permission denied for this resource' ;;
    4) printf 'service unavailable, try again' ;;
    5) printf 'context length exceeded' ;;
    6) printf 'upstream connect error or disconnect/reset before headers' ;;
    7) printf 'socket hang up' ;;
    8) printf 'the model is currently experiencing high demand' ;;
    9) printf 'サーバーが混雑しています' ;;
    10) printf 'invalid json in request body: unexpected token at position 42' ;;
    11) printf 'your account has been permanently suspended for policy violation' ;;
  esac
}

scenario_type() {
  case "$1" in
    0) printf 'success' ;;
    1) printf 'rate_limit_error' ;;
    2) printf 'quota_exceeded_error' ;;
    3) printf 'permission_denied_error' ;;
    4) printf 'server_error' ;;
    5) printf 'context_length_error' ;;
    6|7|8|9) printf 'server_error' ;;
    10) printf 'invalid_request_error' ;;
    11) printf 'permission_denied_error' ;;
  esac
}

for SCENARIO in ${SCENARIOS:-6 7 8 9 10 11}; do
  STATUS="$(scenario_status "$SCENARIO")"
  MESSAGE="$(scenario_message "$SCENARIO")"
  ERROR_TYPE="$(scenario_type "$SCENARIO")"
  (
    # shellcheck source=/dev/null
    source "$COMMON_SH"
    trap 'for pid in "${SSE_PID:-}" "${SERVER_PID:-}" "${FAKE_PID:-}"; do if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; done; oqa_cleanup' EXIT

    oqa_mk_isolated_xdg || fail "scenario $SCENARIO: sandbox creation failed"
    export TMPDIR="$XDG_STATE_HOME/tmp"
    mkdir -p "$TMPDIR" "$HOME/.omo" "$XDG_CONFIG_HOME/opencode"

    FAKE_PORT="$(oqa_free_port)"
    FAKE_LOG="$XDG_STATE_HOME/fake-provider.log"
    PROVIDER_SCRIPT="$XDG_STATE_HOME/fake-provider.mjs"
    : > "$FAKE_LOG"
    cat > "$PROVIDER_SCRIPT" <<'JAVASCRIPT'
import { appendFileSync } from "node:fs"

const port = Number(process.env.FAKE_PORT)
const status = Number(process.env.FAKE_STATUS)
const message = process.env.FAKE_MESSAGE ?? ""
const errorType = process.env.FAKE_ERROR_TYPE ?? "provider_error"
const logFile = process.env.FAKE_LOG

function successBody() {
  const now = Math.floor(Date.now() / 1000)
  const events = [
    { type: "response.created", response: { id: "resp_control", created_at: now, model: "gpt-fake" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_control" } },
    { type: "response.output_text.delta", item_id: "msg_control", output_index: 0, delta: "hi" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_control" } },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url)
    appendFileSync(logFile, `${new Date().toISOString()} ${request.method} ${url.pathname}\n`)
    if (request.method !== "POST") {
      return new Response("ready", { status: 200 })
    }
    if (status === 200) {
      return new Response(successBody(), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } })
    }
    return new Response(JSON.stringify({ error: { message, type: errorType } }), {
      status,
      headers: { "content-type": "application/json" },
    })
  },
})
JAVASCRIPT

    env -u TYPESAFE_API_KEY FAKE_PORT="$FAKE_PORT" FAKE_STATUS="$STATUS" FAKE_MESSAGE="$MESSAGE" FAKE_ERROR_TYPE="$ERROR_TYPE" FAKE_LOG="$FAKE_LOG" bun "$PROVIDER_SCRIPT" >/dev/null 2>&1 &
    FAKE_PID=$!
    oqa_wait_http "http://127.0.0.1:$FAKE_PORT/" "" 10 || fail "scenario $SCENARIO: fake provider not ready"
    BASE_HITS="$(wc -l < "$FAKE_LOG")"

    cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-provider-key",
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
    cat > "$HOME/.omo/omo.jsonc" <<'JSONC'
{
  "[opencode]": {
    "model_fallback": true,
    "jev": {
      "enabled": true,
      "backend": "real",
      "wires": { "model_error_triage": { "enabled": true } }
    }
  }
}
JSONC

    SERVER_PORT="$(oqa_free_port)"
    SERVER_PASS="jev-w4-$SCENARIO"
    SERVER_URL="http://127.0.0.1:$SERVER_PORT"
    SERVER_OUT="$XDG_STATE_HOME/opencode-server.out"
    SERVER_ERR="$XDG_STATE_HOME/opencode-server.err"
    OPENCODE_SERVER_PASSWORD="$SERVER_PASS" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG > "$SERVER_OUT" 2> "$SERVER_ERR" &
    SERVER_PID=$!

    READY=false
    for _ in $(seq 1 60); do
      if curl --max-time 1 -fsS -u "opencode:$SERVER_PASS" "$SERVER_URL/global/health" >/dev/null 2>&1; then
        READY=true
        break
      fi
      sleep 0.5
    done
    [ "$READY" = true ] || fail "scenario $SCENARIO: opencode server not ready"

    EVENTS_RAW="$XDG_STATE_HOME/events.sse"
    timeout 45 curl -NsS -u "opencode:$SERVER_PASS" "$SERVER_URL/global/event" > "$EVENTS_RAW" &
    SSE_PID=$!
    sleep 1

    ENCODED_DIR="$(jq -rn --arg value "$OQA_PROJ" '$value|@uri')"
    SESSION_RESPONSE="$(curl --max-time 15 -fsS -u "opencode:$SERVER_PASS" -X POST "$SERVER_URL/session?directory=$ENCODED_DIR" -H 'content-type: application/json' -d "{\"title\":\"Jev W4 scenario $SCENARIO\"}")"
    SESSION_ID="$(printf '%s' "$SESSION_RESPONSE" | jq -r '.id // .sessionID // empty')"
    [ -n "$SESSION_ID" ] || fail "scenario $SCENARIO: no session ID"
    PROMPT_HTTP="$(curl --max-time 15 -sS -o "$XDG_STATE_HOME/prompt-response.txt" -w '%{http_code}' -u "opencode:$SERVER_PASS" -X POST "$SERVER_URL/session/$SESSION_ID/prompt_async?directory=$ENCODED_DIR" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"say hi"}]}')"
    [ "$PROMPT_HTTP" = 204 ] || fail "scenario $SCENARIO: prompt_async returned $PROMPT_HTTP"

    LOG=""
    CONDITION=false
    for _ in $(seq 1 300); do
      LOG="$(ls "$TMPDIR"/oh-my-open*.log 2>/dev/null | head -1 || true)"
      HITS="$(wc -l < "$FAKE_LOG")"
      if [ -n "$LOG" ] && [ -f "$LOG" ] && [ "$HITS" -gt "$BASE_HITS" ]; then
        JEV_COUNT="$(grep -c '\[jev\] model-error-triage' "$LOG" || true)"
        if [ "$SCENARIO" = 0 ]; then
          if grep -q '"type":"session.idle"' "$EVENTS_RAW" || grep -q '"status":{"type":"idle"' "$EVENTS_RAW"; then
            CONDITION=true
            break
          fi
        elif [ "$JEV_COUNT" -ge 1 ]; then
          CONDITION=true
          break
        fi
      fi
      sleep 0.1
    done
    [ "$CONDITION" = true ] || fail "scenario $SCENARIO: expected lifecycle condition not observed"
    HITS="$(wc -l < "$FAKE_LOG")"
    [ "$HITS" -gt "$BASE_HITS" ] || fail "scenario $SCENARIO: fake provider not reached"
    JEV_COUNT="$(grep -c '\[jev\] model-error-triage' "$LOG" || true)"
    # Preserve network-call results and SSE evidence before any assertion can abort cleanup.
    grep '\[jev\] model-error-triage' "$LOG" | sed -E -e "s|$REPO_ROOT|<repo-root>|g" -e "s|$OQA_XDG_ROOT|<sandbox>|g" -e 's|/home/[^"[:space:]]+|<home>|g' -e 's|/Users/[^"[:space:]]+|<home>|g' -e 's|/tmp/oqa-[^"[:space:]]+|<sandbox>|g' > "$EVIDENCE_DIR/scenario-$SCENARIO-jev.log"
    grep '^data: {' "$EVENTS_RAW" | cut -c7- | jq -c '.payload // .' | sed -E -e "s|$REPO_ROOT|<repo-root>|g" -e "s|$OQA_XDG_ROOT|<sandbox>|g" -e 's|/home/[^"[:space:]]+|<home>|g' -e 's|/Users/[^"[:space:]]+|<home>|g' -e 's|/tmp/oqa-[^"[:space:]]+|<sandbox>|g' > "$EVIDENCE_DIR/scenario-$SCENARIO-events.jsonl"
    if [ "$SCENARIO" = 0 ]; then
      [ "$JEV_COUNT" -eq 0 ] || fail "control emitted $JEV_COUNT Jev lines"
    else
      grep '\[jev\] model-error-triage' "$LOG" | sed 's/^.*\[jev\] model-error-triage //' | jq -c '.' > "$EVIDENCE_DIR/scenario-$SCENARIO-jev.jsonl"
      INVALID_BACKENDS="$(jq -r 'select(.backend != "real") | .backend' "$EVIDENCE_DIR/scenario-$SCENARIO-jev.jsonl" | wc -l)"
      [ "$INVALID_BACKENDS" -eq 0 ] || fail "scenario $SCENARIO did not use real backend"
      MISSING_FIELDS="$(jq -r 'select((["site", "status", "reason", "choice", "confidence", "probabilities", "latencyMs", "errorName", "errorMessageHead", "heuristicShouldRetry", "shouldRetry"] - keys) | length > 0) | .site // "<unknown>"' "$EVIDENCE_DIR/scenario-$SCENARIO-jev.jsonl" | wc -l)"
      [ "$MISSING_FIELDS" -eq 0 ] || fail "scenario $SCENARIO: Jev line is missing required fields"

      LINE_NUMBER=0
      while IFS= read -r JEV_LINE; do
        LINE_NUMBER=$((LINE_NUMBER + 1))
        ERROR_NAME="$(printf '%s' "$JEV_LINE" | jq -r '.errorName // ""')"
        ERROR_MESSAGE="$(printf '%s' "$JEV_LINE" | jq -r '.errorMessageHead // ""')"
        SITE="$(printf '%s' "$JEV_LINE" | jq -r '.site')"
        LOGGED_RESULT="$(printf '%s' "$JEV_LINE" | jq -r '.heuristicShouldRetry')"
        if [ "${#ERROR_MESSAGE}" -ge 200 ]; then
          jq -nc --argjson scenario "$SCENARIO" --argjson line "$LINE_NUMBER" --arg site "$SITE" --arg name "$ERROR_NAME" --arg message "$ERROR_MESSAGE" --argjson providerStatus "$STATUS" --arg providerMessage "$MESSAGE" '{scenario: $scenario, line: $line, site: $site, name: (if ($name | length) > 0 then $name else null end), message: (if ($message | length) > 0 then $message else null end), providerStatus: $providerStatus, providerMessage: $providerMessage, directCheck: "skipped_errorMessageHead_may_be_truncated"}' >> "$HEURISTICS"
          continue
        fi
        DIRECT="$(ERROR_NAME="$ERROR_NAME" ERROR_MESSAGE="$ERROR_MESSAGE" bun -e 'import { shouldRetryError } from "./packages/omo-opencode/src/shared/model-error-classifier"; console.log(JSON.stringify({name: process.env.ERROR_NAME || null, message: process.env.ERROR_MESSAGE || null, heuristicShouldRetry: shouldRetryError({name: process.env.ERROR_NAME || undefined, message: process.env.ERROR_MESSAGE || undefined})}))')"
        printf '%s\n' "$DIRECT" | jq -c --argjson scenario "$SCENARIO" --argjson line "$LINE_NUMBER" --arg site "$SITE" --argjson providerStatus "$STATUS" --arg providerMessage "$MESSAGE" '. + {scenario: $scenario, line: $line, site: $site, providerStatus: $providerStatus, providerMessage: $providerMessage, directCheck: "verified"}' >> "$HEURISTICS"
        DIRECT_RESULT="$(printf '%s' "$DIRECT" | jq -r '.heuristicShouldRetry')"
        [ "$LOGGED_RESULT" = "$DIRECT_RESULT" ] || fail "scenario $SCENARIO line $LINE_NUMBER ($SITE): direct heuristic $DIRECT_RESULT differs from logged $LOGGED_RESULT"
      done < "$EVIDENCE_DIR/scenario-$SCENARIO-jev.jsonl"
    fi

    printf 'scenario=%s provider_status=%s provider_message=%s provider_requests=%s jev_lines=%s\n' "$SCENARIO" "$STATUS" "$MESSAGE" "$((HITS - BASE_HITS))" "$JEV_COUNT" >> "$SUMMARY"

    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
    SSE_PID=""
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    kill "$FAKE_PID" 2>/dev/null || true
    wait "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""

    CURRENT_DB="$(sqlite3 -readonly "$REAL_DB" 'SELECT count(*) FROM session')"
    [ "$CURRENT_DB" = "$DB_BEFORE" ] || fail "scenario $SCENARIO changed real DB count"
  )
done

DB_AFTER="$(sqlite3 -readonly "$REAL_DB" 'SELECT count(*) FROM session')"
[ "$DB_AFTER" = "$DB_BEFORE" ] || fail "real DB changed: $DB_BEFORE -> $DB_AFTER"
printf 'db_sessions_after=%s\n' "$DB_AFTER" >> "$SUMMARY"
printf 'matrix_segment_complete=%s\n' "${SCENARIOS:-6 7 8 9 10 11}" >> "$SUMMARY"

if grep -R -F -q -- "$TYPESAFE_API_KEY" "$EVIDENCE_DIR"; then
  fail "API key found in retained evidence"
fi
printf 'key_leak_matches=0\n' >> "$SUMMARY"
printf 'PASS: Jev W4 matrix completed\n'
