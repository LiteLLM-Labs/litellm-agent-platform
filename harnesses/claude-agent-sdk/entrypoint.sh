#!/usr/bin/env bash
# Claude Agent SDK harness entrypoint.
#
# Mirrors harnesses/opencode/entrypoint.sh's contract so the platform's
# fargate.ts:buildContainerEnv works unchanged: same env vars, same
# clone-then-listen flow, same port.
set -euo pipefail

: "${LITELLM_API_KEY:?LITELLM_API_KEY required}"
: "${LITELLM_API_BASE:?LITELLM_API_BASE required}"
: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

: "${BRANCH:=main}"
: "${PORT:=4096}"
: "${REPO_DIR:=/work/repo}"

# The SDK spawns the `claude` binary with cwd=$REPO_DIR. If the directory
# doesn't exist (no REPO_URL set, or clone failed), spawn fails with
# ENOENT — and the SDK's error message blames "Claude Code native binary
# not found", which is misleading. Always ensure the dir exists so the
# spawn itself succeeds.
mkdir -p "$REPO_DIR"

# Two token paths, matching opencode's contract:
#   GIT_TOKEN: clone-only, wiped from env after clone (read-only PR review).
#   GITHUB_TOKEN / GH_TOKEN: persistent, gh + git push.
CLONE_TOKEN="${GIT_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"

if [ -n "${REPO_URL:-}" ]; then
  if [ ! -d "$REPO_DIR/.git" ]; then
    if [ -n "$CLONE_TOKEN" ]; then
      git -c credential.helper= \
          -c "credential.helper=!f() { echo username=x-access-token; echo password=$CLONE_TOKEN; }; f" \
          clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    fi
  fi
  # Persistent token path: configure a credential helper that reads from env
  # so `gh pr create` and `git push` work without the token landing in argv
  # or .git/config.
  if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && [ -z "${GIT_TOKEN:-}" ]; then
    git -C "$REPO_DIR" config credential.helper "store --file=/tmp/.git-credentials"
    PERSIST_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
    echo "https://x-access-token:${PERSIST_TOKEN}@github.com" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
  fi
fi

# Clone-only token: wipe so the LLM can't `printenv GIT_TOKEN` it back.
unset GIT_TOKEN

# Hand off to the Node server. The server reads ANTHROPIC_BASE_URL +
# ANTHROPIC_AUTH_TOKEN from the LITELLM_* values at boot.
exec node /opt/harnesses/claude-agent-sdk/dist/server.js
