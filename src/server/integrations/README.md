# Integrations

Lets external mediums (Linear today; Slack / GitHub / JIRA next) delegate work to a LAP `Agent` and stream activity back. Every medium is one folder under `providers/`. The generic plumbing lives in `core/`.

## Layout

```
src/server/integrations/
├─ core/
│  ├─ types.ts        Integration interface + event types
│  ├─ crypto.ts       AES-256-GCM token encryption at rest
│  ├─ registry.ts     explicit imports + lookup
│  ├─ oauth.ts        generic CSRF + exchange + upsert install
│  └─ dispatcher.ts   inbound webhook + outbound SessionEvent glue
│
└─ providers/
   └─ linear/
      ├─ index.ts     wires the four siblings into an Integration
      ├─ oauth.ts     Linear OAuth (actor=app)
      ├─ webhook.ts   HMAC-SHA256 verify + AgentSessionEvent parse
      ├─ activity.ts  agentActivityCreate via GraphQL
      └─ prompt.ts    issue → harness prompt
```

Two new Next.js routes wire it into the HTTP surface:

```
src/app/api/integrations/
├─ webhooks/[integration]/route.ts                POST  — inbound
└─ oauth/[integration]/
   ├─ authorize/route.ts                          GET   — start install
   └─ callback/route.ts                           GET   — finish install
```

Both routes are 5-line shims that call into `core/dispatcher` or `core/oauth`.

## Data model

Three tables (see `prisma/schema.prisma`):

| Table | Holds |
| --- | --- |
| `integration_install` | One row per OAuth install per workspace. Owns the encrypted access + refresh tokens. |
| `agent_integration_binding` | Many-to-one against install. The presence of an enabled row = "this agent is reachable via this integration". No boolean column on `Agent`. |
| `integration_session` | Maps a medium's session id (e.g. Linear `agentSession.id`) to a LAP `session_id`. |

## Adding a new provider

1. Create `providers/<id>/index.ts` exporting a default `Integration` (see `providers/linear/index.ts`).
2. Implement the three adapters: `oauth`, `webhook`, `onSessionEvent`.
3. Add an import + array entry in `core/registry.ts`.
4. Add env vars to `.env.example` and document them under the provider's section.

The interface in `core/types.ts` is the contract. Don't reach into `core/` internals from a provider — if you need something that isn't on the interface, the interface should grow.

## Provider responsibilities

Each provider does three jobs:

- **OAuth** — build the authorize URL, exchange the code for tokens, fetch the workspace id + name + medium-specific metadata (e.g. Linear's `app_user_id` for dedup).
- **Webhook** — say which workspace a payload belongs to (so `core/dispatcher` can find the install), verify the signature, and translate the wire format into a canonical `IntegrationEvent`.
- **Outbound** — translate a canonical `SessionEvent` into a medium-specific API call (e.g. Linear's `agentActivityCreate`, Slack's `chat.postMessage`).

That's it. Sandbox lifecycle, warm pool, retry, persistence — all in LAP core. Providers don't see any of it.

## Runtime

Inbound:

```
POST /api/integrations/webhooks/{id}
  → core/dispatcher.handleInbound
    → registry.getProvider(id)
    → provider.webhook.workspaceIdFromPayload(json)
    → prisma.integrationInstall lookup
    → provider.webhook.verify(raw, headers, install)
    → provider.webhook.parse(json, install)
    → switch on event.kind:
        new_task → provider.onSessionEvent(thought)  // sync ack
                 + async POST /api/v1/managed_agents/agents/{id}/session
                 + write integration_session
        followup → async POST /api/v1/managed_agents/sessions/{id}/message
        cancel   → mark Session dead
```

Outbound (called by whatever drives session lifecycle — TODO in v1):

```
core/dispatcher.forwardSessionEvent(session_id, event)
  → prisma.integrationSession lookup → install + agent
  → registry.getProvider(install.integration_id)
  → provider.onSessionEvent(install, externalSessionId, event, agent)
```

`forwardSessionEvent` is exported but not yet wired into LAP's session lifecycle — the harness status change → integration callback is a follow-up.

## Env vars

See `.env.example`. The integration is OFF unless all three env vars for the medium are set (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` for Linear). Disabled providers don't register; their routes return 404. `INTEGRATION_TOKEN_KEY` is required in production for token encryption at rest.

## What's not done yet (v1 scope)

- **No toggle UI.** The `AgentIntegrationBinding` row is the "enable for this agent" flag, but the agent detail page doesn't yet expose a toggle. For now, insert the row via SQL or a one-off script.
- **No settings page.** OAuth install flow works (`/api/integrations/oauth/linear/authorize` is reachable with the master key), but there's no UI listing connected integrations.
- **`forwardSessionEvent` not wired.** Harness status changes don't yet emit `SessionEvent`s. The first message activity goes back to Linear from the dispatcher's initial thought ack; later activities arrive once we add an event hook in the session lifecycle.
- **State store is in-memory.** `core/oauth` uses a process-local Map for CSRF state with a 10-min TTL. Fine for single-instance LAP; multi-instance needs a shared store.
- **One binding per install.** v1 assumes one agent per Linear workspace install. Loosening this is `AgentIntegrationBinding`-only — no schema change required.
