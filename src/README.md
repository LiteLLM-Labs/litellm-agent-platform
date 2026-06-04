# `src/`

Two top-level areas:

## `lite-harness-sdk/`

The **lite-harness SDK** and its servers — drive multiple agent harnesses
(Claude Code, Codex, Pi AI) behind one contract, optionally routed through the
LiteLLM gateway.

- `server/` — stdio stream-json backend spawned per session; provider adapters
  live under `server/providers/` (`anthropic`, `codex`, `pi-ai`).
- `managed-agents/` — HTTP server exposing the harnesses behind the
  **Claude Managed Agents** wire format (`/v1/sessions` + SSE events); spawns
  `server/server.mjs` as a subprocess per session.
- `typescript/` — TypeScript SDK (`query()` + low-level `Transport`).
- `python/` — Python SDK.
- `PROTOCOL.md` — the NDJSON wire protocol between SDK and `server/`.

This area is vendored/standalone: it has no dependency on `agent-platform/`.

## `agent-platform/`

The application — a **self-contained Next.js project** that builds on top of
`lite-harness-sdk`. It owns its own `package.json`, `node_modules`, `prisma/`,
`.env`, and Next/TypeScript config, so the repo root stays clean. Run it from
its own directory:

```bash
cd src/agent-platform
npm install
npm run dev        # next dev
npm run build      # next build  (output: standalone)
npm run worker     # background reconciler
```

Layout: `app/` (Next router) + `instrumentation.ts`, `api/` (backend), `ui/`
(React), `shared/` (types), `agent-templates/` + `agent_templates.json` (data).
Imports use the `@/*` alias → `agent-platform/*`.

---

Tests mirror this layout under the repo-root `tests/` directory, e.g.
`tests/src/lite-harness-sdk/managed-agents/`.
