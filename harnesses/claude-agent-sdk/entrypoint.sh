#!/usr/bin/env bash
# Claude Agent SDK harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

exec node /opt/harnesses/claude-agent-sdk/dist/server.js
