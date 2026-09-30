#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

SANDBOX=""
RECEIPTS=""
WIRE=""
KEEP=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sandbox) [ "$#" -ge 2 ] || fail "--sandbox requires a value"; SANDBOX=$2; shift 2 ;;
    --receipts) [ "$#" -ge 2 ] || fail "--receipts requires a value"; RECEIPTS=$2; shift 2 ;;
    --wire) [ "$#" -ge 2 ] || fail "--wire requires a value"; WIRE=$2; shift 2 ;;
    --keep) KEEP=true; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$SANDBOX" ] || fail "--sandbox is required"
[ -n "$RECEIPTS" ] || fail "--receipts is required"
case "$WIRE" in enabled|disabled) ;; *) fail "--wire must be enabled or disabled" ;; esac

for binary in bun curl jq opencode node; do
  command -v "$binary" >/dev/null || fail "missing required binary: $binary"
done

REPO_ROOT=$(pwd -P)
SCRIPT_DIR="$REPO_ROOT/.omo/evidence/20260924-jev-w1"
TURN_SCRIPT="$SCRIPT_DIR/task-19-turn-script.jsonl"
MODEL_SERVER="$SCRIPT_DIR/task-19-fake-model-provider.ts"
JEV_SERVER="$SCRIPT_DIR/task-19-fake-jev-server.ts"
for required in "$TURN_SCRIPT" "$MODEL_SERVER" "$JEV_SERVER"; do
  [ -f "$required" ] || fail "missing driver input: $required"
done

mkdir -p "$SANDBOX" "$RECEIPTS"
SANDBOX=$(realpath "$SANDBOX")
RECEIPTS=$(realpath "$RECEIPTS")
case "$RECEIPTS/" in "$SANDBOX/"*) fail "--receipts must live outside --sandbox" ;; esac

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_STATE_HOME="$SANDBOX/xdg-state"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export TMPDIR="$SANDBOX/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OMO_DISABLE_PROCESS_CLEANUP=1
export OMO_DISABLE_POSTHOG=1
export TYPESAFE_API_KEY="task19-dummy-sandbox-key"
mkdir -p "$HOME/.omo" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR"

PID_RECEIPT="$RECEIPTS/pids.tsv"
PORT_RECEIPT="$RECEIPTS/ports.tsv"
CLEANUP_RECEIPT="$RECEIPTS/cleanup.tsv"
SUMMARY="$RECEIPTS/summary.txt"
: > "$PID_RECEIPT"
: > "$PORT_RECEIPT"
: > "$CLEANUP_RECEIPT"
: > "$SUMMARY"
printf 'pid\trole\tstate\n' >> "$PID_RECEIPT"
printf 'port\trole\tstate\n' >> "$PORT_RECEIPT"
printf 'pid\trole\tresult\n' >> "$CLEANUP_RECEIPT"

MODEL_PID=""
JEV_PID=""
SERVER_PID=""

record_pid() {
  printf '%s\t%s\tstarted\n' "$1" "$2" >> "$PID_RECEIPT"
}

terminate_pid() {
  local pid=$1 role=$2
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
    printf '%s\t%s\tterminated\n' "$pid" "$role" >> "$CLEANUP_RECEIPT"
  else
    wait "$pid" 2>/dev/null || true
    printf '%s\t%s\talready-exited\n' "$pid" "$role" >> "$CLEANUP_RECEIPT"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  terminate_pid "$SERVER_PID" opencode-server
  terminate_pid "$MODEL_PID" fake-model
  terminate_pid "$JEV_PID" fake-jev
  printf '%s\topencode-server\treleased\n' "${SERVER_PORT:-unset}" >> "$PORT_RECEIPT"
  printf '%s\tfake-model\treleased\n' "${MODEL_PORT:-unset}" >> "$PORT_RECEIPT"
  printf '%s\tfake-jev\treleased\n' "${JEV_PORT:-unset}" >> "$PORT_RECEIPT"
  if [ "$KEEP" != true ]; then rm -rf "$SANDBOX"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

free_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

wait_http() {
  local url=$1 password=${2:-} attempts=${3:-720}
  for _ in $(seq 1 "$attempts"); do
    if [ -n "$password" ]; then
      curl --max-time 1 -fsS -u "opencode:$password" "$url" >/dev/null 2>&1 && return 0
    else
      curl --max-time 1 -fsS "$url" >/dev/null 2>&1 && return 0
    fi
    sleep 0.5
  done
  return 1
}

MODEL_PORT=$(free_port)
JEV_PORT=$(free_port)
SERVER_PORT=$(free_port)
printf '%s\tfake-model\tbound\n' "$MODEL_PORT" >> "$PORT_RECEIPT"
printf '%s\tfake-jev\tbound\n' "$JEV_PORT" >> "$PORT_RECEIPT"
printf '%s\topencode-server\tbound\n' "$SERVER_PORT" >> "$PORT_RECEIPT"

MODEL_LOG="$RECEIPTS/fake-model.log"
JEV_LOG="$RECEIPTS/fake-jev.log"
SERVER_OUT="$RECEIPTS/opencode-server.stdout"
SERVER_ERR="$RECEIPTS/opencode-server.stderr"
: > "$MODEL_LOG"
: > "$JEV_LOG"
: > "$SERVER_OUT"
: > "$SERVER_ERR"

TASK19_MODEL_PORT="$MODEL_PORT" TASK19_MODEL_LOG="$MODEL_LOG" TASK19_TURN_SCRIPT="$TURN_SCRIPT" \
  bun "$MODEL_SERVER" >> "$RECEIPTS/fake-model.stdout" 2>&1 &
MODEL_PID=$!
record_pid "$MODEL_PID" fake-model
TASK19_JEV_PORT="$JEV_PORT" TASK19_JEV_LOG="$JEV_LOG" bun "$JEV_SERVER" >> "$RECEIPTS/fake-jev.stdout" 2>&1 &
JEV_PID=$!
record_pid "$JEV_PID" fake-jev
wait_http "http://127.0.0.1:$MODEL_PORT/health" "" 120 || fail "fake model server did not become ready"
wait_http "http://127.0.0.1:$JEV_PORT/health" "" 120 || fail "fake Jev server did not become ready"

if [ "$WIRE" = enabled ]; then WIRE_BOOL=true; else WIRE_BOOL=false; fi
cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-task19",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "task19-local-model-key",
        "baseURL": "http://127.0.0.1:${MODEL_PORT}/v1",
        "timeout": 30000
      },
      "models": {
        "gpt-task19": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  },
  "agent": {
    "jev-dogfood": {
      "description": "Task 19 deterministic intent-routing dogfood driver",
      "mode": "primary",
      "model": "openai/gpt-task19",
      "permission": { "task": "allow", "call_omo_agent": "allow" }
    }
  },
  "permission": { "task": "allow", "call_omo_agent": "allow" }
}
JSONC

cat > "$HOME/.omo/omo.jsonc" <<JSONC
{
  "[opencode]": {
    "telemetry": false,
    "auto_update": false,
    "tmux": { "enabled": false },
    "tui": { "sidebar": { "enabled": false } },
    "jev": {
      "enabled": true,
      "backend": "real",
      "model": "jev-1.13.0",
      "wires": {
        "intent_routing": {
          "enabled": ${WIRE_BOOL},
          "observe_only": true,
          "confidence_threshold": 0.8,
          "timeout_ms": 5000,
          "turn_seal_timeout_ms": 120000,
          "max_prompt_chars": 8000,
          "max_inflight": 8
        }
      }
    }
  }
}
JSONC

export OMO_JEV_BASE_URL="http://127.0.0.1:$JEV_PORT"
SERVER_PASSWORD="task19-${WIRE}-sandbox"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
export OPENCODE_SERVER_PASSWORD="$SERVER_PASSWORD"
opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG > "$SERVER_OUT" 2> "$SERVER_ERR" &
SERVER_PID=$!
record_pid "$SERVER_PID" opencode-server

if ! wait_http "$SERVER_URL/global/health" "$SERVER_PASSWORD" 720; then
  printf 'BLOCKED: opencode server did not become healthy within 360 seconds\n' >&2
  printf '%s\n' '--- opencode server stdout ---' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$SERVER_OUT"
  printf '%s\n' '--- opencode server stderr ---' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$SERVER_ERR"
  exit 2
fi

run_cli_turn() {
  local turn=$1 prompt=$2 output=$3 error_output=$4
  shift 4
  opencode run "$prompt" --attach "$SERVER_URL" --password "$SERVER_PASSWORD" --format json \
    --model openai/gpt-task19 --agent jev-dogfood --dir "$REPO_ROOT" --auto "$@" < /dev/null > "$output" 2> "$error_output" &
  local run_pid=$!
  record_pid "$run_pid" "opencode-run-$turn"
  local elapsed=0
  while kill -0 "$run_pid" 2>/dev/null; do
    if [ "$elapsed" -ge 3600 ]; then
      kill "$run_pid" 2>/dev/null || true
      wait "$run_pid" 2>/dev/null || true
      printf '%s\t%s\ttimed-out\n' "$run_pid" "opencode-run-$turn" >> "$CLEANUP_RECEIPT"
      fail "turn $turn timed out after 360 seconds"
    fi
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
  local rc=0
  wait "$run_pid" || rc=$?
  printf '%s\t%s\texited-rc-%s\n' "$run_pid" "opencode-run-$turn" "$rc" >> "$CLEANUP_RECEIPT"
  [ "$rc" -eq 0 ] || fail "turn $turn failed with rc=$rc; see $error_output"
}

SID=""
TURN_COUNT=0
while IFS= read -r turn_line; do
  [ -n "$turn_line" ] || continue
  TURN=$(printf '%s' "$turn_line" | jq -r '.turn')
  PROMPT=$(printf '%s' "$turn_line" | jq -r '.prompt')
  OUTPUT="$RECEIPTS/turn-$(printf '%02d' "$TURN").jsonl"
  ERROR_OUTPUT="$RECEIPTS/turn-$(printf '%02d' "$TURN").stderr"
  if [ -z "$SID" ]; then
    run_cli_turn "$TURN" "$PROMPT" "$OUTPUT" "$ERROR_OUTPUT" --title "JEV task 19 dogfood"
    SID=$(jq -r '.. | objects | (.sessionID? // .session_id? // .id? // empty) | select(type == "string" and startswith("ses_"))' "$OUTPUT" | sort -u | sed -n '1p')
    [ -n "$SID" ] || fail "turn 1 output did not expose a session id"
  else
    run_cli_turn "$TURN" "$PROMPT" "$OUTPUT" "$ERROR_OUTPUT" --session "$SID"
  fi
  TURN_COUNT=$((TURN_COUNT + 1))
done < "$TURN_SCRIPT"

[ "$TURN_COUNT" -ge 30 ] || fail "turn script produced only $TURN_COUNT turns"

SINK="$HOME/.omo/jev"
if [ "$WIRE" = enabled ]; then
  OBSERVATIONS=0
  for _ in $(seq 1 120); do
    if compgen -G "$SINK/w1-*.jsonl" >/dev/null; then
      OBSERVATIONS=$(jq -s '[.[] | select(.kind == "observation")] | length' "$SINK"/w1-*.jsonl)
      [ "$OBSERVATIONS" -ge 30 ] && break
    fi
    sleep 0.25
  done
fi

DISPOSE_HTTP=$(curl --max-time 30 -sS -o "$RECEIPTS/global-dispose-response.txt" -w '%{http_code}' \
  -u "opencode:$SERVER_PASSWORD" -X POST "$SERVER_URL/global/dispose" || true)
[ "$DISPOSE_HTTP" = 200 ] || fail "global dispose returned HTTP $DISPOSE_HTTP"
sleep 1
terminate_pid "$SERVER_PID" opencode-server
SERVER_PID=""
terminate_pid "$MODEL_PID" fake-model
MODEL_PID=""
terminate_pid "$JEV_PID" fake-jev
JEV_PID=""

PLUGIN_LOG=""
for candidate in "$TMPDIR"/oh-my-open*.log; do
  if [ -f "$candidate" ]; then PLUGIN_LOG=$candidate; break; fi
done
JEV_LOG_LINES=0
if [ -n "$PLUGIN_LOG" ]; then
  JEV_LOG_LINES=$(grep -F '[jev] intent-routing' "$PLUGIN_LOG" | grep -Fv '[jev] intent-routing failed' | wc -l) || JEV_LOG_LINES=0
  grep -F '[jev] intent-routing' "$PLUGIN_LOG" > "$RECEIPTS/jev-intent-routing.log" || true
else
  : > "$RECEIPTS/jev-intent-routing.log"
fi
JEV_REQUESTS=$(grep -c 'POST /v1/systemone' "$JEV_LOG") || JEV_REQUESTS=0

if [ "$WIRE" = disabled ]; then
  SINK_FILES=0
  if [ -d "$SINK" ]; then SINK_FILES=$(find "$SINK" -type f | wc -l); fi
  [ "$JEV_LOG_LINES" -eq 0 ] || fail "disabled wire emitted $JEV_LOG_LINES intent-routing log lines"
  [ "$JEV_REQUESTS" -eq 0 ] || fail "disabled wire made $JEV_REQUESTS Jev requests"
  [ "$SINK_FILES" -eq 0 ] || fail "disabled wire wrote $SINK_FILES sink files"
  printf 'wire=disabled\nturns=%s\nsession_id=%s\njev_log_lines=0\njev_requests=0\nsink_files=0\nresult=PASS\n' \
    "$TURN_COUNT" "$SID" >> "$SUMMARY"
  exit 0
fi

compgen -G "$SINK/w1-*.jsonl" >/dev/null || fail "enabled wire wrote no sink files"
OBSERVATIONS=$(jq -s '[.[] | select(.kind == "observation")] | length' "$SINK"/w1-*.jsonl)
COUNTER_DELTAS=$(jq -s '[.[] | select(.kind == "counter_delta")] | length' "$SINK"/w1-*.jsonl)
UNIQUE_SESSIONS=$(jq -s -r '[.[] | select(.kind == "observation") | .sessionID] | unique | length' "$SINK"/w1-*.jsonl)
OBSERVED_SID=$(jq -s -r '[.[] | select(.kind == "observation") | .sessionID] | unique | .[0]' "$SINK"/w1-*.jsonl)
ZERO=$(jq -s '[.[] | select(.kind == "observation" and .fanOutBucket == "zero")] | length' "$SINK"/w1-*.jsonl)
ONE=$(jq -s '[.[] | select(.kind == "observation" and .fanOutBucket == "one")] | length' "$SINK"/w1-*.jsonl)
MANY=$(jq -s '[.[] | select(.kind == "observation" and .fanOutBucket == "many")] | length' "$SINK"/w1-*.jsonl)
REUSED=$(jq -s '[.[] | select(.kind == "observation" and .predictionReused == true)] | length' "$SINK"/w1-*.jsonl)
CALL_OMO=$(jq -s '[.[] | select(.kind == "observation") | .observed[] | select(.tool == "call_omo_agent")] | length' "$SINK"/w1-*.jsonl)
RESUME=$(jq -s '[.[] | select(.kind == "observation") | .observed[] | select(.routeClass == "unscorable_resume")] | length' "$SINK"/w1-*.jsonl)
CONTINUATION=$(jq -s '[.[] | select(.kind == "observation" and .isContinuationCandidate == true)] | length' "$SINK"/w1-*.jsonl)
RELIABLE=$(jq -s '[.[] | select(.kind == "observation" and .correlationStatus == "reliable")] | length' "$SINK"/w1-*.jsonl)

[ "$OBSERVATIONS" -ge 30 ] || fail "expected at least 30 observations, got $OBSERVATIONS"
[ "$COUNTER_DELTAS" -ge 1 ] || fail "expected at least one counter_delta"
[ "$UNIQUE_SESSIONS" -eq 1 ] || fail "observations span $UNIQUE_SESSIONS sessions"
[ "$OBSERVED_SID" = "$SID" ] || fail "sink session $OBSERVED_SID differs from CLI session $SID"
[ "$ZERO" -gt 0 ] && [ "$ONE" -gt 0 ] && [ "$MANY" -gt 0 ] || fail "fan-out cohorts incomplete: zero=$ZERO one=$ONE many=$MANY"
[ "$REUSED" -gt 0 ] || fail "predictionReused was never true"
[ "$CALL_OMO" -gt 0 ] || fail "call_omo_agent was not observed"
[ "$RESUME" -gt 0 ] || fail "unscorable_resume was not observed"
[ "$CONTINUATION" -gt 0 ] || fail "no continuation candidate was observed"
[ "$RELIABLE" -gt 0 ] || fail "no reliable correlation record was observed"
[ "$JEV_LOG_LINES" -eq "$JEV_REQUESTS" ] || fail "intent-routing logs ($JEV_LOG_LINES) differ from dispatched Jev requests ($JEV_REQUESTS)"

printf 'wire=enabled\nturns=%s\nsealed_observations=%s\ncounter_deltas=%s\nsession_id=%s\nunique_observation_sessions=%s\nfan_out_zero=%s\nfan_out_one=%s\nfan_out_many=%s\nprediction_reused=%s\ncall_omo_agent=%s\nunscorable_resume=%s\ncontinuation_candidates=%s\ncorrelation_reliable=%s\ncorrelation_censored=0 unreachable=sequential_runs_idle_before_next_prompt\ncorrelation_overlap_ambiguous=0 unreachable=sequential_runs_do_not_overlap\njev_log_lines=%s\njev_requests=%s\nresult=PASS\n' \
  "$TURN_COUNT" "$OBSERVATIONS" "$COUNTER_DELTAS" "$SID" "$UNIQUE_SESSIONS" "$ZERO" "$ONE" "$MANY" \
  "$REUSED" "$CALL_OMO" "$RESUME" "$CONTINUATION" "$RELIABLE" "$JEV_LOG_LINES" "$JEV_REQUESTS" >> "$SUMMARY"
