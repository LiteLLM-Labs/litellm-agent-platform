#!/usr/bin/env bash
# Run the opencode inline harness locally, pointed at your local LAP instance.
# Prerequisites: opencode installed, harness deps installed (npm install).
#
# Usage:
#   cd harnesses/opencode
#   ./start-local.sh
set -euo pipefail

# --- Source LAP .env for LiteLLM + DB creds ---
LAP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$LAP_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$LAP_ROOT/.env"
  set +a
fi

: "${LITELLM_API_BASE:?set LITELLM_API_BASE in .env}"
: "${LITELLM_API_KEY:?set LITELLM_API_KEY in .env}"
: "${LITELLM_DEFAULT_MODEL:=anthropic/claude-sonnet-4-5}"

# Normalize base URL (strip trailing slash, ensure /v1 suffix)
BASE="${LITELLM_API_BASE%/}"
case "$BASE" in
  */v1) ;;
  *) BASE="${BASE}/v1" ;;
esac

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
export REPO_DIR="$HARNESS_DIR"
export LAP_MCP_DIR="$HARNESS_DIR"
export PORT="${OPENCODE_INLINE_PORT:-4096}"
export OPENCODE_CHILD_PORT="$((PORT + 1))"
export OPENCODE_SHARED_INLINE=1
export OPENCODE_INLINE_WORKDIR="${TMPDIR:-/tmp}opencode-agents-local"

# LAP env for MCP tools (memory + issue reporter)
export LAP_BASE_URL="${LAP_BASE_URL:-http://localhost:3000}"
export LITELLM_API_BASE="$BASE"
export LITELLM_API_KEY

mkdir -p "$OPENCODE_INLINE_WORKDIR"

echo "[start-local] base=$BASE model=$LITELLM_DEFAULT_MODEL port=$PORT"

# --- Discover models from the gateway ---
opts_for='def opts(id): if (id|test("opus-4-7")) then {options:{thinking:{type:"adaptive",display:"summarized"},effort:"high"}} elif (id|test("sonnet")) or (id|test("opus")) then {options:{thinking:{type:"enabled",budgetTokens:8000}}} else {} end;'
MODELS_JSON=$(
  curl -fsS --max-time 10 \
    -H "Authorization: Bearer ${LITELLM_API_KEY}" \
    "${BASE}/models" 2>/dev/null \
    | jq -c "${opts_for} [.data[].id | select(test(\"claude|opus|sonnet|haiku\"))] | unique | map({(.): opts(.)}) | add // {}" 2>/dev/null \
  || printf '{}'
)
[ -n "$MODELS_JSON" ] || MODELS_JSON='{}'
MODELS_JSON=$(printf '%s' "$MODELS_JSON" \
  | jq -c "${opts_for} if has(\"${LITELLM_DEFAULT_MODEL}\") then . else . + {\"${LITELLM_DEFAULT_MODEL}\": opts(\"${LITELLM_DEFAULT_MODEL}\")} end")
echo "[start-local] models: $(printf '%s' "$MODELS_JSON" | jq -r 'keys | join(", ")')"

# --- Build MCP config ---
MCP_OBJ=$(node "$HARNESS_DIR/gen-mcp-config.mjs" 2>/tmp/gen-mcp-local.err || echo '{}')
[ -z "$MCP_OBJ" ] && MCP_OBJ='{}'
MCP_BLOCK="  \"mcp\": ${MCP_OBJ},"
MCP_NAMES=$(printf '%s' "$MCP_OBJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(Object.keys(JSON.parse(s)).join(", "))}catch{}})')
echo "[start-local] MCP servers: ${MCP_NAMES:-none}"
[ -s /tmp/gen-mcp-local.err ] && cat /tmp/gen-mcp-local.err

# --- Write opencode.json into REPO_DIR ---
cat > "$HARNESS_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
${MCP_BLOCK}
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "${BASE}",
        "apiKey": "${LITELLM_API_KEY}"
      },
      "models": ${MODELS_JSON}
    }
  },
  "model": "litellm/${LITELLM_DEFAULT_MODEL}",
  "permission": {
    "edit": "deny",
    "bash": "deny",
    "question": "deny",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  }
}
EOF

echo "[start-local] wrote opencode.json"
echo "[start-local] starting inline adapter on :${PORT}"
exec node "$HARNESS_DIR/inline-adapter.mjs"
