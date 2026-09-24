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
for command_name in bun curl jq node opencode realpath timeout; do
  command -v "$command_name" >/dev/null || fail "missing command: $command_name"
done

mkdir -p "$SANDBOX" "$RECEIPTS"
SANDBOX=$(realpath "$SANDBOX")
RECEIPTS=$(realpath "$RECEIPTS")
case "$RECEIPTS/" in "$SANDBOX/"*) fail "--receipts must live outside --sandbox" ;; esac

REPO_ROOT=$(pwd)
EVIDENCE_DIR="$REPO_ROOT/.omo/evidence/20260924-jev-w1"
TURN_SCRIPT="$EVIDENCE_DIR/task-19-turn-script.jsonl"
MODEL_SERVER="$EVIDENCE_DIR/task-19-fake-model-provider.ts"
JEV_SERVER="$EVIDENCE_DIR/task-19-fake-jev-server.ts"
for file in "$TURN_SCRIPT" "$MODEL_SERVER" "$JEV_SERVER"; do [ -f "$file" ] || fail "missing harness file: $file"; done

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_STATE_HOME="$SANDBOX/xdg-state"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export TMPDIR="$SANDBOX/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OMO_DISABLE_PROCESS_CLEANUP=1
export OMO_DISABLE_CODEGRAPH=1
export OMO_DISABLE_POSTHOG=1
export TYPESAFE_API_KEY="task19-sandbox-dummy-key"
mkdir -p "$HOME/.omo" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR"

PIDS_FILE="$RECEIPTS/pids.tsv"
PORTS_FILE="$RECEIPTS/ports.tsv"
: > "$PIDS_FILE"
: > "$PORTS_FILE"
declare -a LIVE_PIDS=()
declare -a BOUND_PORTS=()
declare -A PID_ROLES=()
declare -A DONE_PIDS=()

record_pid() {
  local pid=$1 role=$2 state=$3
  printf '%s\t%s\t%s\n' "$pid" "$role" "$state" >> "$PIDS_FILE"
}

register_pid() {
  local pid=$1 role=$2
  LIVE_PIDS+=("$pid")
  PID_ROLES[$pid]=$role
  record_pid "$pid" "$role" spawned
}

free_port() {
  node -e 'const n=require("node:net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

port_is_closed() {
  node -e 'const n=require("node:net"),p=Number(process.argv[1]),s=n.connect({host:"127.0.0.1",port:p});s.once("connect",()=>{s.destroy();process.exit(1)});s.once("error",()=>process.exit(0));setTimeout(()=>{s.destroy();process.exit(0)},500)' "$1"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${LIVE_PIDS[@]}"; do
    if [ "${DONE_PIDS[$pid]:-}" = 1 ]; then continue; fi
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
      wait "$pid" 2>/dev/null || true
      record_pid "$pid" "${PID_ROLES[$pid]}" terminated
    fi
  done
  for port in "${BOUND_PORTS[@]}"; do
    if port_is_closed "$port"; then
      printf '%s\tclosed\n' "$port" >> "$PORTS_FILE"
    else
      printf '%s\tSTILL_BOUND\n' "$port" >> "$PORTS_FILE"
      status=1
    fi
  done
  if [ "$KEEP" = false ]; then rm -rf -- "$SANDBOX"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

MODEL_PORT=$(free_port)
JEV_PORT=$(free_port)
SERVER_PORT=$(free_port)
BOUND_PORTS=("$MODEL_PORT" "$JEV_PORT" "$SERVER_PORT")
printf '%s\tfake-model\tbound\n%s\tfake-jev\tbound\n%s\topencode-serve\tbound\n' "$MODEL_PORT" "$JEV_PORT" "$SERVER_PORT" >> "$PORTS_FILE"

MODEL_LOG="$XDG_STATE_HOME/fake-model.jsonl"
JEV_LOG="$XDG_STATE_HOME/fake-jev.jsonl"
SERVER_OUT="$XDG_STATE_HOME/opencode-server.out"
SERVER_ERR="$XDG_STATE_HOME/opencode-server.err"
: > "$MODEL_LOG"; : > "$JEV_LOG"; : > "$SERVER_OUT"; : > "$SERVER_ERR"

TASK19_MODEL_PORT="$MODEL_PORT" TASK19_MODEL_LOG="$MODEL_LOG" TASK19_TURN_SCRIPT="$TURN_SCRIPT" bun run "$MODEL_SERVER" > "$XDG_STATE_HOME/fake-model.out" 2>&1 &
MODEL_PID=$!; register_pid "$MODEL_PID" fake-model
TASK19_JEV_PORT="$JEV_PORT" TASK19_JEV_LOG="$JEV_LOG" bun run "$JEV_SERVER" > "$XDG_STATE_HOME/fake-jev.out" 2>&1 &
JEV_PID=$!; register_pid "$JEV_PID" fake-jev

for endpoint in "http://127.0.0.1:$MODEL_PORT/health" "http://127.0.0.1:$JEV_PORT/health"; do
  ready=false
  for _ in $(seq 1 100); do if curl -fsS --max-time 1 "$endpoint" >/dev/null 2>&1; then ready=true; break; fi; sleep 0.1; done
  [ "$ready" = true ] || fail "fake endpoint did not become healthy"
done

WIRE_BOOL=false
[ "$WIRE" = enabled ] && WIRE_BOOL=true
cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "agent": {
    "task19-driver": {
      "description": "Deterministic todo 19 QA driver",
      "mode": "primary",
      "model": "openai/gpt-fake",
      "prompt": "Follow the scripted local provider response.",
      "permission": { "*": "allow" }
    }
  },
  "provider": {
    "openai": {
      "options": { "apiKey": "sandbox-model-key", "baseURL": "http://127.0.0.1:${MODEL_PORT}/v1", "timeout": 30000 },
      "models": { "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } } }
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
    "experimental": { "max_tools": 200 },
    "categories": {
      "quick": { "model": "openai/gpt-fake" },
      "writing": { "model": "openai/gpt-fake" }
    },
    "agents": {
      "explore": { "model": "openai/gpt-fake" },
      "librarian": { "model": "openai/gpt-fake" }
    },
    "jev": {
      "enabled": ${WIRE_BOOL},
      "backend": "real",
      "model": "jev-1.13.0",
      "wires": {
        "intent_routing": {
          "enabled": ${WIRE_BOOL},
          "observe_only": true,
          "confidence_threshold": 0.8,
          "timeout_ms": 10000,
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

SERVER_PASS="task19-${WIRE}-sandbox"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
OPENCODE_SERVER_PASSWORD="$SERVER_PASS" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG > "$SERVER_OUT" 2> "$SERVER_ERR" &
SERVER_PID=$!; register_pid "$SERVER_PID" opencode-serve
ready=false
for _ in $(seq 1 480); do
  if curl -fsS --max-time 1 -u "opencode:$SERVER_PASS" "$SERVER_URL/global/health" >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$ready" = true ] || { printf '%s\n' "server_log_start"; cat "$SERVER_ERR"; printf '%s\n' "server_log_end"; fail "opencode server did not become healthy"; }

SID=""
TURN_COUNT=0
while IFS= read -r script_line; do
  [ -n "$script_line" ] || continue
  TURN_COUNT=$((TURN_COUNT + 1))
  PROMPT=$(jq -er '.prompt' <<<"$script_line")
  TURN_AGENT="task19-driver"
  RUN_TIMEOUT=120
  TASK_ID_ONLY=false
  if [ "$(jq '[.calls[] | select(.tool == "task" and (.args | keys == ["task_id"]))] | length' <<<"$script_line")" -gt 0 ]; then
    RUN_TIMEOUT=10
    TASK_ID_ONLY=true
  fi
  TURN_OUT="$XDG_STATE_HOME/turn-$(printf '%02d' "$TURN_COUNT").jsonl"
  if [ -z "$SID" ]; then
    timeout "$RUN_TIMEOUT" opencode run --attach "$SERVER_URL" --password "$SERVER_PASS" --format json --model openai/gpt-fake --agent "$TURN_AGENT" "$PROMPT" < /dev/null > "$TURN_OUT" 2>&1 &
  else
    timeout "$RUN_TIMEOUT" opencode run --attach "$SERVER_URL" --password "$SERVER_PASS" --format json --model openai/gpt-fake --agent "$TURN_AGENT" --session "$SID" "$PROMPT" < /dev/null > "$TURN_OUT" 2>&1 &
  fi
  RUN_PID=$!; register_pid "$RUN_PID" "opencode-run-$TURN_COUNT"
  set +e; wait "$RUN_PID"; RUN_RC=$?; set -e
  DONE_PIDS[$RUN_PID]=1
  record_pid "$RUN_PID" "opencode-run-$TURN_COUNT" "exited-$RUN_RC"
  if [ "$TASK_ID_ONLY" = true ] && [ "$RUN_RC" -eq 124 ]; then
    curl -fsS --max-time 10 -u "opencode:$SERVER_PASS" -X POST "$SERVER_URL/session/$SID/abort" >/dev/null
    sleep 1
    continue
  fi
  [ "$RUN_RC" -eq 0 ] || { cat "$TURN_OUT"; fail "turn $TURN_COUNT failed with $RUN_RC"; }
  if [ -z "$SID" ]; then
    SID=$(sed -n '/^{/p' "$TURN_OUT" | jq -r 'select(type == "object") | .sessionID // empty' | sed -n '1p')
    [ -n "$SID" ] || { cat "$TURN_OUT"; fail "turn 1 did not expose a sessionID"; }
  fi
done < "$TURN_SCRIPT"
[ "$TURN_COUNT" -ge 30 ] || fail "turn script has fewer than 30 turns"

if [ "$WIRE" = enabled ]; then
  for _ in $(seq 1 70); do
    if find "$HOME/.omo/jev" -maxdepth 1 -type f -name 'w1-*.jsonl' -exec grep -q '"kind":"counter_delta"' {} + 2>/dev/null; then break; fi
    sleep 1
  done
fi
kill -TERM "$SERVER_PID" 2>/dev/null || true
for _ in $(seq 1 100); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$SERVER_PID" 2>/dev/null; then kill -KILL "$SERVER_PID" 2>/dev/null || true; fi
wait "$SERVER_PID" 2>/dev/null || true
DONE_PIDS[$SERVER_PID]=1
record_pid "$SERVER_PID" opencode-serve terminated
LOG=$(find "$TMPDIR" -maxdepth 1 -type f -name 'oh-my-open*.log' -print -quit)
[ -n "$LOG" ] || fail "plugin log was not created under sandbox TMPDIR"
JEV_DISPATCHES=$(jq -r 'select(.event == "systemOne") | 1' "$JEV_LOG" | wc -l)
JEV_LINES=$(grep -c '] \[jev\] intent-routing {' "$LOG" || true)
SINK="$HOME/.omo/jev"

if [ "$WIRE" = disabled ]; then
  SINK_FILES=0
  [ ! -d "$SINK" ] || SINK_FILES=$(find "$SINK" -type f | wc -l)
  [ "$JEV_DISPATCHES" -eq 0 ] || fail "disabled control contacted fake Jev $JEV_DISPATCHES times"
  [ "$JEV_LINES" -eq 0 ] || fail "disabled control emitted $JEV_LINES intent-routing logs"
  [ "$SINK_FILES" -eq 0 ] || fail "disabled control created $SINK_FILES sink files"
  printf 'wire=disabled server_url=http://127.0.0.1:<sandbox-port> turns=%s sessionID=%s jev_dispatches=0 intent_logs=0 sink_files=0\n' "$TURN_COUNT" "$SID"
  exit 0
fi

[ "$JEV_DISPATCHES" -eq "$JEV_LINES" ] || fail "Jev dispatches ($JEV_DISPATCHES) do not match intent logs ($JEV_LINES)"
SINK_FILE=$(find "$SINK" -maxdepth 1 -type f -name 'w1-*.jsonl' -print -quit)
[ -n "$SINK_FILE" ] || fail "enabled run produced no sink file"
OBSERVATIONS=$(jq -s '[.[] | select(.kind == "observation")]' "$SINK_FILE")
SEALED=$(jq 'length' <<<"$OBSERVATIONS")
[ "$SEALED" -ge 30 ] || fail "enabled run sealed only $SEALED observations"
UNIQUE_SIDS=$(jq '[.[].sessionID] | unique | length' <<<"$OBSERVATIONS")
[ "$UNIQUE_SIDS" -eq 1 ] || fail "observations span $UNIQUE_SIDS session IDs"
[ "$(jq -r '.[0].sessionID' <<<"$OBSERVATIONS")" = "$SID" ] || fail "sink sessionID differs from attached session"
for bucket in zero one many; do [ "$(jq --arg value "$bucket" '[.[] | select(.fanOutBucket == $value)] | length' <<<"$OBSERVATIONS")" -gt 0 ] || fail "fan-out bucket $bucket is empty"; done
[ "$(jq '[.[] | select(.predictionReused == true)] | length' <<<"$OBSERVATIONS")" -gt 0 ] || fail "predictionReused was never true"
[ "$(jq '[.[] | .observed[] | select(.tool == "call_omo_agent")] | length' <<<"$OBSERVATIONS")" -gt 0 ] || fail "call_omo_agent was not observed"
[ "$(jq '[.[] | .observed[] | select(.routeClass == "unscorable_resume")] | length' <<<"$OBSERVATIONS")" -gt 0 ] || fail "unscorable_resume was not observed"
[ "$(jq '[.[] | select(.isContinuationCandidate == true)] | length' <<<"$OBSERVATIONS")" -gt 0 ] || fail "continuation candidate was not observed"
COUNTER_DELTAS=$(jq -s '[.[] | select(.kind == "counter_delta")] | length' "$SINK_FILE")
[ "$COUNTER_DELTAS" -gt 0 ] || fail "no counter_delta was written"
CORRELATIONS=$(jq -r '[.[].correlationStatus] | unique | join(",")' <<<"$OBSERVATIONS")
printf 'wire=enabled server_url=http://127.0.0.1:<sandbox-port> sessionID=%s turns=%s sealed=%s counter_delta=%s jev_dispatches=%s intent_logs=%s fanout=zero,one,many predictionReused=true call_omo_agent=true unscorable_resume=true continuation=true correlationStatus=%s\n' "$SID" "$TURN_COUNT" "$SEALED" "$COUNTER_DELTAS" "$JEV_DISPATCHES" "$JEV_LINES" "$CORRELATIONS"
