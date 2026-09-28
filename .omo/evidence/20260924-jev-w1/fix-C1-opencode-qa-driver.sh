#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(pwd)
REAL_DB=$(opencode db path)
REAL_SESSION_COUNT_BEFORE=$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session;')
SANDBOX=$(mktemp -d /tmp/omo-c1-signal-qa.XXXXXX)
SERVER_PID=""
SERVER_DONE=false

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$SERVER_DONE" = false ] && [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$SANDBOX"
  exit "$status"
}
trap cleanup EXIT INT TERM

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_STATE_HOME="$SANDBOX/xdg-state"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export TMPDIR="$SANDBOX/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OMO_DISABLE_CODEGRAPH=1
export OMO_DISABLE_POSTHOG=1
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR"

cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO_ROOT}/packages/omo-opencode/src/index.ts"]
}
JSONC

SERVER_PORT=$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
SERVER_PASSWORD=c1-signal-gate-sandbox
SERVER_OUT="$XDG_STATE_HOME/opencode-server.out"
SERVER_ERR="$XDG_STATE_HOME/opencode-server.err"
OPENCODE_SERVER_PASSWORD="$SERVER_PASSWORD" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" --print-logs --log-level DEBUG > "$SERVER_OUT" 2> "$SERVER_ERR" &
SERVER_PID=$!

SERVER_READY=false
for _ in $(seq 1 120); do
  if curl -fsS --max-time 1 -u "opencode:$SERVER_PASSWORD" "http://127.0.0.1:$SERVER_PORT/global/health" >/dev/null 2>&1; then
    SERVER_READY=true
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.25
done
[ "$SERVER_READY" = true ] || { printf 'server failed to become healthy\n'; exit 1; }

AGENT_RESPONSE=$(curl -fsS --max-time 10 -u "opencode:$SERVER_PASSWORD" "http://127.0.0.1:$SERVER_PORT/agent?directory=$REPO_ROOT")
jq -e 'any(.[]; .name == "Sisyphus - ultraworker")' <<<"$AGENT_RESPONSE" >/dev/null || { printf 'local plugin agent was not present\n'; exit 1; }

kill -TERM "$SERVER_PID"
for _ in $(seq 1 40); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  printf 'server did not exit after direct SIGTERM\n'
  exit 1
fi

set +e
wait "$SERVER_PID"
SERVER_EXIT_CODE=$?
set -e
SERVER_DONE=true
[ "$SERVER_EXIT_CODE" -eq 0 ] || { printf 'unexpected server exit code: %s\n' "$SERVER_EXIT_CODE"; exit 1; }

REAL_SESSION_COUNT_AFTER=$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session;')
[ "$REAL_SESSION_COUNT_AFTER" = "$REAL_SESSION_COUNT_BEFORE" ] || { printf 'real session count changed\n'; exit 1; }

printf 'WHAT WAS TESTED: real OpenCode loaded the local plugin with the default disabled Jev config, became healthy, then received SIGTERM directly without POST /global/dispose.\n'
printf 'WHAT WAS OBSERVED: server_exit_code=%s; sigkill_used=false; sisyphus_agent_present=true; real_session_count_before=%s; real_session_count_after=%s.\n' "$SERVER_EXIT_CODE" "$REAL_SESSION_COUNT_BEFORE" "$REAL_SESSION_COUNT_AFTER"
printf 'WHY IT IS ENOUGH: the real harness proves default plugin startup and direct process shutdown remain functional; focused real process.listenerCount tests prove the exact listener registration contract.\n'
printf 'WHAT WAS OMITTED: sandbox logs and generated auth data were deleted after assertions; no credentials or auth headers were retained.\n'
