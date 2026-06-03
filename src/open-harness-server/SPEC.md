# Open Harness Server — API Specification

HTTP server that exposes any lite-harness agent (Claude, Codex, Pi AI, or custom) behind the **Claude Managed Agents wire format**. Apps built against `api.anthropic.com/v1` work against this server without code changes.

---

## Base URL

```
http://localhost:4096
```

## Auth

```
Authorization: Bearer <token>
```

Set `OPEN_HARNESS_API_KEY` env var to enforce. Unset = open (dev mode).

## Beta header

Accepted for compatibility, not enforced:

```
anthropic-beta: managed-agents-2026-04-01
```

---

## Endpoints

```
POST   /v1/agents                 create agent config
GET    /v1/agents                 list agents
GET    /v1/agents/:id             get agent
DELETE /v1/agents/:id             delete agent

POST   /v1/environments           create environment config
GET    /v1/environments           list environments
GET    /v1/environments/:id       get environment
DELETE /v1/environments/:id       delete environment

POST   /v1/sessions               start session (spawns subprocess)
GET    /v1/sessions               list sessions
GET    /v1/sessions/:id           get session info
DELETE /v1/sessions/:id           destroy session

POST   /v1/sessions/:id/events    send user message → 200 (async)
GET    /v1/sessions/:id/stream    SSE stream of session events

GET    /v1/models                 list available harnesses
```

---

## Agents

### POST /v1/agents

```json
{
  "name": "Coding Assistant",
  "model": "claude-opus-4-8",
  "system": "You are a helpful coding assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

Response `201`:

```json
{
  "id": "agent_a1b2c3d4",
  "version": 1,
  "name": "Coding Assistant",
  "model": "claude-opus-4-8",
  "system": "You are a helpful coding assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

### GET /v1/agents

```json
{
  "agents": [{ "id": "agent_a1b2c3d4", "name": "Coding Assistant", "model": "claude-opus-4-8" }]
}
```

### GET /v1/agents/:id

Returns full agent object (same shape as POST response).

### DELETE /v1/agents/:id

Response `204`.

---

## Environments

### POST /v1/environments

```json
{
  "name": "my-env",
  "config": {
    "type": "cloud",
    "networking": { "type": "unrestricted" }
  }
}
```

`config.type` values:

| Value | Behavior |
|-------|----------|
| `"cloud"` | Anthropic-compatible (maps to default sandbox) |
| `"local"` | Agent runs in local CWD (open-harness extension) |

Response `201`:

```json
{
  "id": "env_e1f2g3h4",
  "name": "my-env",
  "config": { "type": "cloud", "networking": { "type": "unrestricted" } }
}
```

### GET /v1/environments

```json
{
  "environments": [{ "id": "env_e1f2g3h4", "name": "my-env" }]
}
```

### GET /v1/environments/:id

Returns full environment object.

### DELETE /v1/environments/:id

Response `204`.

---

## Sessions

### POST /v1/sessions

Spawns a subprocess for the given agent + environment pair.

```json
{
  "agent": "agent_a1b2c3d4",
  "environment_id": "env_e1f2g3h4",
  "title": "My coding session"
}
```

Response `201`:

```json
{
  "id": "session_s1t2u3v4",
  "status": "idle",
  "agent": "agent_a1b2c3d4",
  "environment_id": "env_e1f2g3h4",
  "title": "My coding session",
  "created_at": "2026-06-03T00:00:00Z"
}
```

`status` values: `"idle"` | `"running"` | `"error"`

### GET /v1/sessions

```json
{
  "sessions": [
    { "id": "session_s1t2u3v4", "status": "idle", "title": "My coding session" }
  ]
}
```

### GET /v1/sessions/:id

Returns full session object.

### DELETE /v1/sessions/:id

Closes subprocess stdin, kills process. Response `204`.

---

## Events

### POST /v1/sessions/:id/events

Fire-and-forget. Returns immediately; agent runs in background. Subscribe to `GET /v1/sessions/:id/stream` for output.

```json
{
  "events": [
    {
      "type": "user.message",
      "content": [
        { "type": "text", "text": "Write a Python Fibonacci script" }
      ]
    }
  ]
}
```

Response `200`:

```json
{ "ok": true }
```

**Event types accepted:**

| Type | Description |
|------|-------------|
| `user.message` | Send a prompt to the agent |

---

## Stream

### GET /v1/sessions/:id/stream

SSE stream. One event per line, `data: <json>\n\n`.

```
Content-Type: text/event-stream
Cache-Control: no-cache
```

Every event includes `session_id` for demuxing if you connect a single global listener.

**Event shapes:**

```
data: {"type":"agent.message","session_id":"session_s1t2u3v4","content":[{"type":"text","text":"I'll help with that..."}]}

data: {"type":"agent.tool_use","session_id":"session_s1t2u3v4","name":"bash","input":{"command":"python3 fib.py"}}

data: {"type":"agent.tool_result","session_id":"session_s1t2u3v4","tool_use_id":"tu_abc123","content":"0\n1\n1\n2\n3..."}

data: {"type":"session.status_idle","session_id":"session_s1t2u3v4"}

data: {"type":"session.status_error","session_id":"session_s1t2u3v4","error":"agent exited unexpectedly"}
```

**Event type reference:**

| Type | Meaning |
|------|---------|
| `agent.message` | Agent text response (complete block) |
| `agent.tool_use` | Agent invoked a tool |
| `agent.tool_result` | Tool execution result |
| `session.status_idle` | Agent finished, no pending work |
| `session.status_error` | Agent encountered an unrecoverable error |

The stream stays open between turns. Send another `POST /events` to continue the conversation; new events flow on the same stream.

---

## Models

### GET /v1/models

Lists available harnesses (providers).

```json
{
  "models": [
    { "id": "anthropic", "aliases": ["claude", "claude-code", "cc"] },
    { "id": "codex",     "aliases": [] },
    { "id": "pi-ai",    "aliases": [] }
  ]
}
```

---

## Full Example (curl)

```bash
export BASE=http://localhost:4096
export KEY=your-token

# 1. Create agent
AGENT=$(curl -sS -X POST $BASE/v1/agents \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"coder","model":"claude-opus-4-8","system":"You are a coding assistant.","tools":[{"type":"agent_toolset_20260401"}]}')
AGENT_ID=$(echo $AGENT | jq -r .id)

# 2. Create environment
ENV=$(curl -sS -X POST $BASE/v1/environments \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"local","config":{"type":"local"}}')
ENV_ID=$(echo $ENV | jq -r .id)

# 3. Create session
SESSION=$(curl -sS -X POST $BASE/v1/sessions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"demo\"}")
SESSION_ID=$(echo $SESSION | jq -r .id)

# 4. Open stream (background)
curl -sS -N $BASE/v1/sessions/$SESSION_ID/stream \
  -H "Authorization: Bearer $KEY" &

# 5. Send message
curl -sS -X POST $BASE/v1/sessions/$SESSION_ID/events \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"hello, what can you do?"}]}]}'
```

---

## Architecture Notes

- **One subprocess per session.** Each session spawns a `lite-harness-server` process. The HTTP server bridges HTTP ↔ subprocess NDJSON.
- **Async by default.** `POST /events` writes to subprocess stdin and returns immediately. The subprocess drives the agent loop; events stream back via SSE.
- **Multi-turn.** The stream stays open. Send additional `POST /events` calls on the same session for follow-up turns.
- **In-memory state.** Agent/environment/session records live in memory. Restart clears all state.

### Internal frame translation

The subprocess speaks NDJSON ([PROTOCOL.md](../open-harness-sdk/PROTOCOL.md)). The server translates:

| Subprocess frame | SSE event |
|-----------------|-----------|
| `{ type: "assistant" }` | `agent.message` |
| `{ type: "user", content: [{type:"tool_result"}] }` | `agent.tool_result` |
| `{ type: "result", subtype: "success" }` | `session.status_idle` |
| `{ type: "result", subtype: "error_*" }` | `session.status_error` |
