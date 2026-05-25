#!/usr/bin/env bash
# litellm-up — start the LiteLLM proxy and only return once it's actually serving.
#
# Prints PORT / MASTER_KEY / URL on stdout when /health/readiness == 200.
# Exits non-zero with diagnostics (proxy log tail + OOM check) if the proxy
# dies or never becomes ready — so callers never hang on a silent failure.
#
# Usage:  litellm-up [PORT]        # PORT optional; a free one is chosen if omitted
set -uo pipefail

# 1. Postgres (idempotent, shared with start-db).
/usr/local/bin/start-db

# 2. Dev env (only fills gaps — image ENV already sets these).
export DATABASE_URL="${DATABASE_URL:-postgresql://litellm:litellm@localhost:5432/litellm}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-1234}"
export LITELLM_SALT_KEY="${LITELLM_SALT_KEY:-sk-litellm-salt-dev-unsafe}"
export STORE_MODEL_IN_DB="${STORE_MODEL_IN_DB:-True}"

# 3. Port — caller-supplied, else a free one. Never hardcode 4000.
PORT="${1:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')}"

LOGDIR=/tmp/llmlogs; mkdir -p "$LOGDIR"
LOG="$LOGDIR/proxy.${PORT}.log"
CONFIG="${LITELLM_CONFIG:-/tmp/litellm_config.yaml}"
cd "${LITELLM_DIR:-/home/user/litellm}"

echo "[litellm-up] starting proxy on :$PORT (log: $LOG)" >&2
nohup python -m litellm.proxy.proxy_cli --config "$CONFIG" --port "$PORT" > "$LOG" 2>&1 &
PID=$!

fail() {
  echo "[litellm-up] $1" >&2
  echo "----- last 40 lines of $LOG -----" >&2
  tail -40 "$LOG" >&2 2>/dev/null || true
  if dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -3 | grep -q .; then
    echo "----- OOM detected (dmesg) — the proxy was killed for memory. Use the litellm-4gb template, not base. -----" >&2
    dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -3 >&2
  fi
  exit 1
}

# 4. Wait up to ~150s for readiness; detect a dead process immediately.
for _ in $(seq 1 75); do
  kill -0 "$PID" 2>/dev/null || fail "proxy process exited before becoming ready."
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health/readiness" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "PORT=$PORT"
    echo "MASTER_KEY=$LITELLM_MASTER_KEY"
    echo "URL=http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 2
done
fail "readiness never returned 200 after ~150s."
