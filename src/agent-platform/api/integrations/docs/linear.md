# Linear integration — setup

Lets a LAP agent be delegated to from a Linear issue. Webhook in, `agentActivityCreate` out. End-to-end happy path takes ~1.5s from delegation to the "Picking up …" thought appearing on the issue.

## Prerequisites

- Linear workspace where you have admin access
- A reachable HTTPS URL for this LAP deployment. Linear's edge calls the webhook URL directly.
  - **Production**: your `BASE_URL` domain
  - **Local dev**: an `ngrok` / `cloudflared` tunnel

## 1. Create the OAuth app in Linear

Linear → **Settings → API → Applications → Create new**.

| Field | Value |
| --- | --- |
| Name | `LAP agent` (or whatever) |
| Developer URL | `<BASE_URL>` |
| Callback URLs | `<BASE_URL>/api/integrations/oauth/linear/callback` |
| Webhook URL | `<BASE_URL>/api/integrations/webhooks/linear` |
| Webhook events | **Agent session events** (required) |

Save, then copy:
- **Client ID**
- **Client secret**
- **Webhook signing secret**

The integration auto-requests these scopes: `read`, `write`, `app:assignable`, `app:mentionable`. No manual scope config needed.

## 2. Configure LAP env

Add to `.env`:

```bash
BASE_URL=https://your-lap-deployment

# 32-byte AES key for token encryption at rest. Required in prod.
# Generate once: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=<base64-32-bytes>

LINEAR_CLIENT_ID=<from step 1>
LINEAR_CLIENT_SECRET=<from step 1>
LINEAR_WEBHOOK_SECRET=<from step 1>
```

Restart LAP. If any of the three `LINEAR_*` vars is empty, the integration stays disabled and its routes return 404 (the rest of the platform is unaffected).

## 3. Install into a workspace

Hit the authorize endpoint from a browser logged into the LAP dashboard:

```
GET <BASE_URL>/api/integrations/oauth/linear/authorize
```

It 302s to `linear.app/oauth/authorize?actor=app&…`. Sign in if prompted, click **Authorize**. You land on a "Linear connected for &lt;workspace&gt;" page once the `integration_install` row is written.

Verify:

```sql
SELECT install_id, workspace_name, metadata->>'app_user_id' AS app_user_id
FROM integration_install WHERE integration_id='linear';
```

## 4. Bind an agent to the install

Until the dashboard toggle ships, write the binding manually:

```sql
INSERT INTO agent_integration_binding (binding_id, agent_id, install_id, enabled)
VALUES (
  gen_random_uuid(),
  '<agent_id from managed_agent>',
  (SELECT install_id FROM integration_install WHERE integration_id='linear'),
  true
);
```

The agent now appears in Linear's **Delegate** picker on every issue in the bound workspace.

## 5. Smoke test

In Linear, open any issue → **Delegate** → pick the agent. Within ~2s you should see a `Picking up <issue-id>.` thought in the agent activity panel. The session spawn continues asynchronously after that.

To query the activities programmatically (using your app's bearer token):

```graphql
query {
  agentSession(id: "<session_id from the webhook>") {
    status
    activities {
      nodes {
        createdAt
        content {
          __typename
          ... on AgentActivityThoughtContent { body }
          ... on AgentActivityErrorContent { body }
          ... on AgentActivityResponseContent { body }
        }
      }
    }
  }
}
```

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `404` on `/api/integrations/webhooks/linear` | A `LINEAR_*` env var is missing | Set all three; restart |
| `401 bad signature` on webhook | `LINEAR_WEBHOOK_SECRET` mismatch | Re-copy the signing secret from the Linear app page |
| `404 install not found` | OAuth install never completed | Re-run step 3 |
| `404 no agent bound to this install` | No row in `agent_integration_binding` | Run step 4 |
| `204` on webhook (silent) | Event was `AppUserNotification`, not `AgentSessionEvent` | Expected for non-delegation events; ignore |
| Thought activity never appears in Linear UI | Check dev log for `agentActivityCreate` errors | Usually a stale token or missing scope — uninstall + reinstall |
| OAuth callback says "already installed" | App was previously installed in the workspace | Linear → Settings → Applications → uninstall, then redo step 3 |

## Local dev quickstart

Walking the whole thing locally (assuming Postgres on `:5432`, `npm run dev`):

```bash
# Tunnel
ngrok http 3000
export BASE_URL=https://<your-ngrok-subdomain>.ngrok-free.dev

# Update the Linear app's Callback URL + Webhook URL to use $BASE_URL,
# then put the three secrets into .env and restart.

npm run dev
```

When iterating on the parser, replay a captured webhook from ngrok's inspector instead of re-delegating in Linear:

```bash
python3 <<'PY'
import json, urllib.request, base64
with urllib.request.urlopen("http://localhost:4040/api/requests/http?limit=10") as r:
    d = json.load(r)
rec = next(x for x in d["requests"]
           if "/webhooks/linear" in x["request"]["uri"]
           and "AgentSessionEvent" in str(x["request"]["headers"].get("Linear-Event","")))
req = rec["request"]
raw = base64.b64decode(req["raw"]).decode()
body = raw.split("\r\n\r\n", 1)[1]
def H(k):
    v = req["headers"].get(k, "")
    return v[0] if isinstance(v, list) else v
r2 = urllib.request.Request(
    "http://localhost:3000/api/integrations/webhooks/linear",
    method="POST", data=body.encode(),
    headers={"content-type": "application/json",
             "linear-signature": H("Linear-Signature"),
             "linear-event": H("Linear-Event")})
print(urllib.request.urlopen(r2).status)
PY
```

## Where the code lives

| Path | Role |
| --- | --- |
| `src/api/integrations/providers/linear/oauth.ts` | OAuth (authorize/exchange/refresh, `actor=app`) |
| `src/api/integrations/providers/linear/webhook.ts` | HMAC verify + payload parse |
| `src/api/integrations/providers/linear/activity.ts` | Outbound `agentActivityCreate` |
| `src/api/integrations/providers/linear/prompt.ts` | Linear issue → harness prompt |
| `src/api/integrations/providers/linear/index.ts` | Wires the four together |
| `src/api/integrations/core/dispatcher.ts` | Inbound + outbound glue (medium-agnostic) |

See [`../README.md`](../README.md) for the cross-provider architecture and how to add a second medium.
