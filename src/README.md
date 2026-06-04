# `src/`

Two top-level areas:

## `open-harness-sdk/`

The **lite-harness SDK** and its servers — drive multiple agent harnesses
(Claude Code, Codex, Pi AI) behind one contract, optionally routed through the
LiteLLM gateway.

- `server/` — stdio stream-json backend spawned per session; provider adapters
  live under `server/providers/` (`anthropic`, `codex`, `pi-ai`).
- `server/managed-agents/` — HTTP server exposing the harnesses behind the
  **Claude Managed Agents** wire format (`/v1/sessions` + SSE events).
- `typescript/` — TypeScript SDK (`query()` + low-level `Transport`).
- `python/` — Python SDK.
- `PROTOCOL.md` — the NDJSON wire protocol between SDK and `server/`.

This area is vendored/standalone: it has no dependency on `agent-platform/`.

## `agent-platform/`

Application-platform code (everything that is **not** the SDK) — entry points
and platform services that build on top of `open-harness-sdk`.

---

Tests mirror this layout under the repo-root `tests/` directory, e.g.
`tests/src/open-harness-sdk/server/managed-agents/`.
