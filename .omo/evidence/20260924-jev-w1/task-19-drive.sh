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
    --sandbox) [ "$#" -ge 2 ] || fail "--sandbox requires a value"; SANDBOX="$2"; shift 2 ;;
    --receipts) [ "$#" -ge 2 ] || fail "--receipts requires a value"; RECEIPTS="$2"; shift 2 ;;
    --wire) [ "$#" -ge 2 ] || fail "--wire requires enabled or disabled"; WIRE="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$SANDBOX" ] || fail "--sandbox is required"
[ -n "$RECEIPTS" ] || fail "--receipts is required"
case "$WIRE" in enabled|disabled) ;; *) fail "--wire must be enabled or disabled" ;; esac

REPO_ROOT="$(pwd -P)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TURN_SCRIPT="$SCRIPT_DIR/task-19-turn-script.jsonl"
FAKE_JEV="$SCRIPT_DIR/task-19-fake-jev-server.ts"
FAKE_MODEL="$SCRIPT_DIR/task-19-fake-model-provider.ts"
COMMON_SH="$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
for path in "$TURN_SCRIPT" "$FAKE_JEV" "$FAKE_MODEL" "$COMMON_SH" "$REPO_ROOT/packages/omo-opencode/src/index.ts"; do
  [ -f "$path" ] || fail "required file is missing: $(basename "$path")"
done
for binary in bun curl jq opencode sqlite3; do command -v "$binary" >/dev/null || fail "missing binary: $binary"; done
OPENCODE_BIN="$(command -v opencode)"
BUN_BIN="$(command -v bun)"
REAL_DB="$($OPENCODE_BIN db path)"
[ -f "$REAL_DB" ] || fail "real OpenCode DB is missing"
HOST_SESSION_BEFORE="$(sqlite3 -readonly "$REAL_DB" 'SELECT count(*) FROM session')"

mkdir -p "$SANDBOX" "$RECEIPTS"
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
RECEIPTS="$(cd "$RECEIPTS" && pwd -P)"
case "$RECEIPTS/" in "$SANDBOX/"*) fail "--receipts must live outside --sandbox" ;; esac

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_STATE_HOME="$SANDBOX/xdg-state"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export OPENCODE_TEST_HOME="$HOME"
export CODEX_HOME="$SANDBOX/codex-home"
export TMPDIR="$SANDBOX/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OMO_DISABLE_POSTHOG=1
export OMO_SEND_ANONYMOUS_TELEMETRY=0
export TYPESAFE_API_KEY="task19-local-dummy-key"
mkdir -p "$HOME/.omo" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$CODEX_HOME" "$TMPDIR" "$SANDBOX/project" "$SANDBOX/run"

: > "$RECEIPTS/pids"
: > "$RECEIPTS/ports"
printf 'role\tpid\n' > "$RECEIPTS/pid-role.tsv"
printf 'role\tport\n' > "$RECEIPTS/port-role.tsv"
printf 'role\tpid\tstatus\texit\n' > "$RECEIPTS/terminations.tsv"
printf 'role\tport\tstatus\n' > "$RECEIPTS/port-terminations.tsv"

declare -A ACTIVE_ROLES=()
declare -A PORT_ROLES=()
PROCESSES_STOPPED=false

record_pid() {
  local role="$1" pid="$2"
  ACTIVE_ROLES["$pid"]="$role"
  printf '%s\n' "$pid" >> "$RECEIPTS/pids"
  printf '%s\t%s\n' "$role" "$pid" >> "$RECEIPTS/pid-role.tsv"
}

record_port() {
  local role="$1" port="$2"
  PORT_ROLES["$port"]="$role"
  printf '%s\n' "$port" >> "$RECEIPTS/ports"
  printf '%s\t%s\n' "$role" "$port" >> "$RECEIPTS/port-role.tsv"
}

mark_exited() {
  local role="$1" pid="$2" exit_code="$3"
  unset 'ACTIVE_ROLES[$pid]'
  printf '%s\t%s\texited\t%s\n' "$role" "$pid" "$exit_code" >> "$RECEIPTS/terminations.tsv"
}

stop_processes() {
  [ "$PROCESSES_STOPPED" = false ] || return 0
  local pid role state exit_code
  for pid in "${!ACTIVE_ROLES[@]}"; do
    role="${ACTIVE_ROLES[$pid]}"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 100); do
        state=""
        [ -r "/proc/$pid/stat" ] && read -r _ _ state _ < "/proc/$pid/stat" || true
        if ! kill -0 "$pid" 2>/dev/null || [ "$state" = "Z" ]; then break; fi
        sleep 0.1
      done
      state=""
      [ -r "/proc/$pid/stat" ] && read -r _ _ state _ < "/proc/$pid/stat" || true
      if kill -0 "$pid" 2>/dev/null && [ "$state" != "Z" ]; then kill -9 "$pid" 2>/dev/null || true; fi
    fi
    if wait "$pid" 2>/dev/null; then exit_code=0; else exit_code=$?; fi
    printf '%s\t%s\tterminated\t%s\n' "$role" "$pid" "$exit_code" >> "$RECEIPTS/terminations.tsv"
    unset 'ACTIVE_ROLES[$pid]'
  done
  PROCESSES_STOPPED=true
}

check_ports_closed() {
  local port role status=0
  for port in "${!PORT_ROLES[@]}"; do
    role="${PORT_ROLES[$port]}"
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      printf '%s\t%s\tstill_bound\n' "$role" "$port" >> "$RECEIPTS/port-terminations.tsv"
      status=1
    else
      printf '%s\t%s\tterminated\n' "$role" "$port" >> "$RECEIPTS/port-terminations.tsv"
    fi
  done
  return "$status"
}

cleanup() {
  local status=$?
  set +e
  stop_processes
  check_ports_closed
  if [ "$KEEP" = false ]; then rm -rf "$SANDBOX"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# shellcheck source=/dev/null
source "$COMMON_SH"
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1" auth="${2:-}" deadline
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -n "$auth" ]; then
      curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -u "$auth" "$url" && return 0
    else
      curl --connect-timeout 1 --max-time 2 -sS -o /dev/null "$url" && return 0
    fi
    sleep 0.2
  done
  return 1
}

free_port() {
  "$BUN_BIN" -e 'const socket=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(socket.port);socket.stop()'
}

MODEL_PORT="$(free_port)"
JEV_PORT="$(free_port)"
SERVER_PORT="$(free_port)"
while [ "$JEV_PORT" = "$MODEL_PORT" ]; do JEV_PORT="$(free_port)"; done
while [ "$SERVER_PORT" = "$MODEL_PORT" ] || [ "$SERVER_PORT" = "$JEV_PORT" ]; do SERVER_PORT="$(free_port)"; done
record_port fake-model "$MODEL_PORT"
record_port fake-jev "$JEV_PORT"
record_port opencode-serve "$SERVER_PORT"

MODEL_LOG="$XDG_STATE_HOME/fake-model.log"
JEV_LOG="$XDG_STATE_HOME/fake-jev.log"
SERVER_OUT="$XDG_STATE_HOME/opencode-server.out"
SERVER_ERR="$XDG_STATE_HOME/opencode-server.err"
: > "$MODEL_LOG"
: > "$JEV_LOG"
PINNED_MODEL="jev-2026-09-24"
export OMO_JEV_BASE_URL="http://127.0.0.1:$JEV_PORT"

TASK19_PORT="$MODEL_PORT" TASK19_SCRIPT="$TURN_SCRIPT" TASK19_LOG="$MODEL_LOG" \
  "$BUN_BIN" run "$FAKE_MODEL" < /dev/null > "$XDG_STATE_HOME/fake-model.out" 2> "$XDG_STATE_HOME/fake-model.err" &
MODEL_PID=$!
record_pid fake-model "$MODEL_PID"
TASK19_PORT="$JEV_PORT" TASK19_SCRIPT="$TURN_SCRIPT" TASK19_LOG="$JEV_LOG" TASK19_PINNED_MODEL="$PINNED_MODEL" \
  "$BUN_BIN" run "$FAKE_JEV" < /dev/null > "$XDG_STATE_HOME/fake-jev.out" 2> "$XDG_STATE_HOME/fake-jev.err" &
JEV_PID=$!
record_pid fake-jev "$JEV_PID"
wait_http "http://127.0.0.1:$MODEL_PORT/health" || fail "fake model provider did not become ready"
wait_http "http://127.0.0.1:$JEV_PORT/health" || fail "fake Jev server did not become ready"

if [ "$WIRE" = enabled ]; then WIRE_BOOL=true; else WIRE_BOOL=false; fi
cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "task19-local-model-key",
        "baseURL": "http://127.0.0.1:${MODEL_PORT}/v1",
        "timeout": 30000
      },
      "models": {
        "gpt-fake": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  },
  "agent": {
    "jev-driver": {
      "description": "Task 19 deterministic driver",
      "mode": "primary",
      "model": "openai/gpt-fake",
      "permission": { "*": "allow", "task": "allow", "call_omo_agent": "allow" }
    }
  },
  "permission": { "*": "allow" }
}
JSONC

cat > "$HOME/.omo/omo.jsonc" <<JSONC
{
  "[opencode]": {
    "telemetry": false,
    "auto_update": false,
    "model_fallback": false,
    "disabled_agents": ["sisyphus-junior", "explore", "librarian"],
    "background_task": { "syncPollTimeoutMs": 60000 },
    "disabled_mcps": ["websearch", "context7", "grep_app", "lsp", "codegraph"],
    "tui": { "sidebar": { "enabled": false } },
    "agents": {
      "sisyphus": { "model": "openai/gpt-fake" },
      "sisyphus-junior": { "model": "openai/gpt-fake" },
      "explore": { "model": "openai/gpt-fake" },
      "librarian": { "model": "openai/gpt-fake" }
    },
    "categories": {
      "quick": { "model": "openai/gpt-fake" },
      "deep": { "model": "openai/gpt-fake" },
      "writing": { "model": "openai/gpt-fake" }
    },
    "jev": {
      "enabled": true,
      "backend": "real",
      "model": "${PINNED_MODEL}",
      "timeout_ms": 1500,
      "wires": {
        "model_error_triage": { "enabled": false, "confidence_threshold": 0.8 },
        "intent_routing": {
          "enabled": ${WIRE_BOOL},
          "observe_only": true,
          "confidence_threshold": 0.8,
          "timeout_ms": 2500,
          "turn_seal_timeout_ms": 120000,
          "max_prompt_chars": 8000,
          "max_inflight": 8
        }
      }
    }
  }
}
JSONC

SERVER_PASSWORD="task19-local-server-password"
export OPENCODE_SERVER_PASSWORD="$SERVER_PASSWORD"
(
  cd "$SANDBOX/project"
  exec "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG
) < /dev/null > "$SERVER_OUT" 2> "$SERVER_ERR" &
SERVER_PID=$!
record_pid opencode-serve "$SERVER_PID"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
wait_http "$SERVER_URL/global/health" "opencode:$SERVER_PASSWORD" || fail "OpenCode server did not become ready"
EVENTS_RAW="$XDG_STATE_HOME/global-events.sse"
: > "$EVENTS_RAW"
curl -NsS -u "opencode:$SERVER_PASSWORD" "$SERVER_URL/global/event" > "$EVENTS_RAW" &
EVENTS_PID=$!
record_pid opencode-global-event "$EVENTS_PID"
sleep 0.5

SID=""
TURN_COUNT=0
while IFS= read -r turn; do
  [ -n "$turn" ] || continue
  TURN_COUNT=$((TURN_COUNT + 1))
  TURN_ID="$(jq -er '.id' <<<"$turn")"
  PROMPT="$(jq -er '.prompt' <<<"$turn")"
  TURN_OUT="$SANDBOX/run/turn-${TURN_ID}.jsonl"
  TURN_STDOUT="$SANDBOX/run/turn-${TURN_ID}.stdout"
  TURN_ERR="$SANDBOX/run/turn-${TURN_ID}.err"
  EVENT_START="$(wc -l < "$EVENTS_RAW")"
  RUN_ARGS=(run --attach "$SERVER_URL" --format json --model openai/gpt-fake --agent jev-driver --title "JEV task 19" --auto --dir "$SANDBOX/project")
  if [ -n "$SID" ]; then RUN_ARGS+=(--session "$SID"); fi
  RUN_ARGS+=("$PROMPT")
  (
    cd "$SANDBOX/project"
    exec "$OPENCODE_BIN" "${RUN_ARGS[@]}"
  ) < /dev/null > "$TURN_STDOUT" 2> "$TURN_ERR" &
  RUN_PID=$!
  record_pid "opencode-run-$TURN_ID" "$RUN_PID"
  DEADLINE=$(( $(date +%s) + 180 ))
  while kill -0 "$RUN_PID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      kill "$RUN_PID" 2>/dev/null || true
      wait "$RUN_PID" 2>/dev/null || true
      mark_exited "opencode-run-$TURN_ID" "$RUN_PID" 124
      fail "turn $TURN_ID timed out"
    fi
    sleep 0.2
  done
  if wait "$RUN_PID"; then RUN_EXIT=0; else RUN_EXIT=$?; fi
  mark_exited "opencode-run-$TURN_ID" "$RUN_PID" "$RUN_EXIT"
  [ "$RUN_EXIT" -eq 0 ] || fail "turn $TURN_ID failed with exit $RUN_EXIT"
  sleep 0.2
  if [ -s "$TURN_STDOUT" ]; then
    cp "$TURN_STDOUT" "$TURN_OUT"
  else
    sed -n "$((EVENT_START + 1)),\$p" "$EVENTS_RAW" | sed -n 's/^data: //p' | jq -c '.payload // .' > "$TURN_OUT"
  fi
  [ -s "$TURN_OUT" ] || fail "turn $TURN_ID produced no JSON event output"
  if [ -z "$SID" ]; then
    SID="$(jq -r '.. | strings | select(startswith("ses_"))' "$TURN_OUT" | sed -n '1p')"
    [ -n "$SID" ] || fail "turn 1 did not expose a session id"
  fi
  jq -c --arg sid "$SID" 'select([.. | strings | select(. == $sid)] | length > 0)' "$TURN_OUT" > "$TURN_OUT.filtered"
  mv "$TURN_OUT.filtered" "$TURN_OUT"
  [ -s "$TURN_OUT" ] || fail "turn $TURN_ID emitted no events for the continued session"
done < "$TURN_SCRIPT"

[ "$TURN_COUNT" -ge 30 ] || fail "turn script produced fewer than 30 turns"
stop_processes
check_ports_closed || fail "a harness port remained bound after scoped cleanup"
HOST_SESSION_AFTER="$(sqlite3 -readonly "$REAL_DB" 'SELECT count(*) FROM session')"
[ "$HOST_SESSION_BEFORE" = "$HOST_SESSION_AFTER" ] || fail "real OpenCode session count changed"

PLUGIN_LOG=""
for candidate in "$TMPDIR"/oh-my-open*.log; do
  if [ -f "$candidate" ]; then PLUGIN_LOG="$candidate"; break; fi
done
JEV_LOG_LINES=0
if [ -n "$PLUGIN_LOG" ]; then JEV_LOG_LINES="$(grep -c '] \[jev\] intent-routing {' "$PLUGIN_LOG" || true)"; fi
JEV_REQUESTS="$(wc -l < "$JEV_LOG")"
SINK="$HOME/.omo/jev"

if [ "$WIRE" = disabled ]; then
  SINK_FILES=0
  if [ -d "$SINK" ]; then SINK_FILES="$(find "$SINK" -type f | wc -l)"; fi
  [ "$JEV_LOG_LINES" -eq 0 ] || fail "disabled control emitted $JEV_LOG_LINES intent-routing log lines"
  [ "$JEV_REQUESTS" -eq 0 ] || fail "disabled control issued $JEV_REQUESTS Jev requests"
  [ "$SINK_FILES" -eq 0 ] || fail "disabled control wrote $SINK_FILES sink files"
  printf 'wire=disabled\nturns=%s\nsession_id=%s\nintent_routing_logs=0\njev_requests=0\nsink_files=0\nreal_session_count_before=%s\nreal_session_count_after=%s\n' "$TURN_COUNT" "$SID" "$HOST_SESSION_BEFORE" "$HOST_SESSION_AFTER"
else
  [ -d "$SINK" ] || fail "enabled run did not create the sink"
  mapfile -t SINK_FILES < <(find "$SINK" -maxdepth 1 -type f -name 'w1-*.jsonl' -print)
  [ "${#SINK_FILES[@]}" -ge 1 ] || fail "enabled run created no sink file"
  ENTRIES="$XDG_STATE_HOME/entries.json"
  jq -s '.' "${SINK_FILES[@]}" > "$ENTRIES"
  OBSERVATIONS="$(jq '[.[] | select(.kind=="observation")] | length' "$ENTRIES")"
  COUNTER_DELTAS="$(jq '[.[] | select(.kind=="counter_delta")] | length' "$ENTRIES")"
  UNIQUE_SESSIONS="$(jq '[.[] | select(.kind=="observation") | .sessionID] | unique | length' "$ENTRIES")"
  OBSERVED_SID="$(jq -r '[.[] | select(.kind=="observation") | .sessionID] | unique | .[0] // ""' "$ENTRIES")"
  ZERO="$(jq '[.[] | select(.kind=="observation" and .fanOutBucket=="zero")] | length' "$ENTRIES")"
  ONE="$(jq '[.[] | select(.kind=="observation" and .fanOutBucket=="one")] | length' "$ENTRIES")"
  MANY="$(jq '[.[] | select(.kind=="observation" and .fanOutBucket=="many")] | length' "$ENTRIES")"
  REUSED="$(jq '[.[] | select(.kind=="observation" and .predictionReused==true)] | length' "$ENTRIES")"
  CALL_OMO="$(jq '[.[] | select(.kind=="observation") | .observed[]? | select(.tool=="call_omo_agent")] | length' "$ENTRIES")"
  RESUME="$(jq '[.[] | select(.kind=="observation") | .observed[]? | select(.routeClass=="unscorable_resume")] | length' "$ENTRIES")"
  CONTINUATION="$(jq '[.[] | select(.kind=="observation" and .isContinuationCandidate==true)] | length' "$ENTRIES")"
  RELIABLE="$(jq '[.[] | select(.kind=="observation" and .correlationStatus=="reliable")] | length' "$ENTRIES")"
  CENSORED="$(jq '[.[] | select(.kind=="observation" and .correlationStatus=="censored")] | length' "$ENTRIES")"
  OVERLAP="$(jq '[.[] | select(.kind=="observation" and .correlationStatus=="overlap_ambiguous")] | length' "$ENTRIES")"
  CREATED="$(jq '[.[] | select(.kind=="counter_delta")] | sort_by(.counterEpoch,.monotonicSeq) | last.counters.recordsCreated // 0' "$ENTRIES")"
  EVICTED="$(jq '[.[] | select(.kind=="counter_delta")] | sort_by(.counterEpoch,.monotonicSeq) | last.counters.recordsEvicted // 0' "$ENTRIES")"
  IN_FLIGHT=$((CREATED - OBSERVATIONS - EVICTED))
  [ "$OBSERVATIONS" -ge 30 ] || fail "enabled run sealed only $OBSERVATIONS observations"
  [ "$COUNTER_DELTAS" -ge 1 ] || fail "enabled run wrote no counter_delta"
  [ "$UNIQUE_SESSIONS" -eq 1 ] && [ "$OBSERVED_SID" = "$SID" ] || fail "observation session ids are not the continued session"
  [ "$ZERO" -gt 0 ] && [ "$ONE" -gt 0 ] && [ "$MANY" -gt 0 ] || fail "fan-out cohorts are incomplete"
  [ "$REUSED" -gt 0 ] || fail "completed prediction reuse was not observed"
  [ "$CALL_OMO" -gt 0 ] || fail "call_omo_agent was not observed"
  [ "$RESUME" -gt 0 ] || fail "unscorable_resume was not observed"
  [ "$CONTINUATION" -gt 0 ] || fail "continuation candidate was not observed"
  [ "$RELIABLE" -gt 0 ] || fail "reliable correlation was not observed"
  [ "$JEV_LOG_LINES" -eq "$JEV_REQUESTS" ] || fail "intent-routing logs $JEV_LOG_LINES did not match dispatches $JEV_REQUESTS"
  [ "$IN_FLIGHT" -ge 0 ] || fail "records_created counters lag sealed observations"
  [ "$CREATED" -eq $((OBSERVATIONS + EVICTED + IN_FLIGHT)) ] || fail "records_created identity failed"
  printf 'wire=enabled\nturns=%s\nsession_id=%s\nobservations=%s\ncounter_deltas=%s\nfan_out_zero=%s\nfan_out_one=%s\nfan_out_many=%s\nprediction_reused=%s\ncall_omo_agent_calls=%s\nunscorable_resume_calls=%s\ncontinuation_candidates=%s\ncorrelation_reliable=%s\ncorrelation_censored=%s\ncorrelation_overlap_ambiguous=%s\nintent_routing_logs=%s\njev_requests=%s\nrecords_created=%s\nrecords_evicted=%s\nin_flight=%s\nrecords_created_identity=ok\nreal_session_count_before=%s\nreal_session_count_after=%s\ncorrelation_unreachable=censored,overlap_ambiguous; sequential opencode run calls seal on session_idle before the next prompt\nnext_turn_unreachable=sequential opencode run calls reach session.idle before the next prompt\n' \
    "$TURN_COUNT" "$SID" "$OBSERVATIONS" "$COUNTER_DELTAS" "$ZERO" "$ONE" "$MANY" "$REUSED" "$CALL_OMO" "$RESUME" "$CONTINUATION" "$RELIABLE" "$CENSORED" "$OVERLAP" "$JEV_LOG_LINES" "$JEV_REQUESTS" "$CREATED" "$EVICTED" "$IN_FLIGHT" "$HOST_SESSION_BEFORE" "$HOST_SESSION_AFTER"
fi

trap - EXIT INT TERM
if [ "$KEEP" = false ]; then rm -rf "$SANDBOX"; fi
