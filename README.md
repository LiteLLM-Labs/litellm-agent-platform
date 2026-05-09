# LiteLLM Agent Platform

Give your team coding agents that run in real sandboxes. Each agent is a little spec — a model, a system prompt, a GitHub repo to clone — and every time someone "spawns a session" we boot a fresh AWS Fargate task running the [opencode](https://opencode.ai) harness, point it at that repo, and hand back a URL they can chat with. Models go through a [LiteLLM](https://github.com/BerriAI/litellm) gateway so spend, keys, and routing stay in one place.

The whole thing is one Next.js app + a sidecar reconciler. No Python proxy, no second service to deploy.

## 1. Create an Agent

<img width="1164" height="720" alt="split1" src="https://github.com/user-attachments/assets/2c4371a3-dc4b-4ca0-a1a8-a09006ac3314" />

## 2. Use your Agent on the UI

<img width="1164" height="720" alt="d7" src="https://github.com/user-attachments/assets/a39e1d74-9fd1-4db9-b090-9bffc49b09d5" />

---

## For platform admins — get it running

You'll need:

- Docker Desktop running on your laptop (only used once, to build and push the harness image).
- An AWS account with a default VPC and credentials that can do ECS, ECR, EC2, IAM, CloudWatch Logs, and STS.
- A Postgres database (Neon, RDS, anywhere).
- A LiteLLM gateway you control (this is what your agents will call for model traffic).
- Node 20+.

Clone, install, and copy the env example:

```bash
git clone https://github.com/BerriAI/litellm-agent-platform
cd litellm-agent-platform
npm install
cp .env.example .env
```

Open `.env` and fill in the obvious stuff first — `DATABASE_URL`, `MASTER_KEY` (anything ≥ 8 chars; this is what users sign in with), `AWS_REGION`, your `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, and `LITELLM_API_BASE` / `LITELLM_API_KEY`. Leave the four AWS infra fields (`AWS_TASK_DEFINITION_ARN`, `AWS_SUBNETS`, `AWS_SECURITY_GROUP`, `OPENCODE_IMAGE_URI`) blank — `setup.sh` will fill those for you.

Now run setup:

```bash
./setup.sh
```

That script is plain bash + the `aws` CLI + Docker. It's idempotent — re-run it any time. It does the boring AWS yak-shaving for you: creates an ECR repo, builds `harnesses/opencode/Dockerfile` for `linux/amd64` (works on Apple Silicon via QEMU) and pushes it, creates the IAM execution role, the log group, the ECS cluster, finds a public subnet in your default VPC, opens port 4096 on a security group, and registers a Fargate task definition. When it's done it prints four lines:

```
AWS_TASK_DEFINITION_ARN=arn:aws:ecs:us-east-1:...:task-definition/litellm-agents-opencode:1
AWS_SUBNETS=subnet-...
AWS_SECURITY_GROUP=sg-...
OPENCODE_IMAGE_URI=...dkr.ecr.us-east-1.amazonaws.com/litellm-agents-opencode:abc1234
```

Paste those into `.env`, then create the database tables and start the two processes:

```bash
npx prisma db push
npm run dev       # :3000 — Next.js + API
npm run worker    # reconciler loop, 60s tick
```

Open http://localhost:3000. You'll get bounced to `/login` — paste your `MASTER_KEY` and you're in.

### Giving the agent access to private things

Anything you put in `.env` with a `CONTAINER_ENV_` prefix gets injected into every Fargate container at session start, with the prefix stripped. So if your agent needs a GitHub PAT to clone private repos:

```bash
CONTAINER_ENV_GITHUB_TOKEN=ghp_...
```

…and the harness sees `GITHUB_TOKEN=ghp_...` in its environment.

### What it costs

A `ready` session = a running Fargate task = roughly **$0.04/hr** at the default 0.5 vCPU + 1 GB. The reconciler kills sessions that have been idle for 24 hours, so a forgotten tab caps out around $1 before it's reaped. The full sweep, every `RECONCILE_INTERVAL_SECONDS`:

- Orphan tasks (running on AWS but with no row in DB, or row says `dead`) → `StopTask`. 5-minute grace for tasks that just launched.
- Sessions stuck in `creating` for more than 10 minutes → marked `failed`.
- Sessions in `ready` whose `last_seen_at` is more than 24 hours old → killed (`failure_reason: "idle timeout"`).

You can always stop a session yourself: `DELETE /api/v1/managed_agents/sessions/{id}`, or click "End session" in the UI.

### Custom harnesses

Don't want opencode? The platform doesn't care, as long as your container exposes the same two HTTP endpoints — `POST /session` and `POST /session/{id}/message` — on `CONTAINER_PORT`. Drop your Dockerfile under `harnesses/<your-id>/` and re-run `./setup.sh`. At session start the platform injects:

| Env the container sees | Where it comes from |
| --- | --- |
| `REPO_URL` | the agent's `repo_url`, or `PREINSTALLED_GITHUB_REPO` if blank |
| `BRANCH` | the agent's `branch` (default `main`) |
| `LITELLM_API_BASE`, `LITELLM_API_KEY` | your gateway, so the harness can call models |
| `LITELLM_DEFAULT_MODEL` | the agent's `model` |
| `AGENT_PROMPT` | the agent's system prompt |
| `PORT` | `CONTAINER_PORT` |
| `<anything>` | every `CONTAINER_ENV_<X>` you set on the host |

Read those at startup (e.g. in `entrypoint.sh`) and you're done.

---

## For developers — call an agent from code

The UI is just a client of the same REST API your scripts can hit. Auth is `Authorization: Bearer <MASTER_KEY>` on every request.

Spin up a session and send it a message:

```bash
KEY=$MASTER_KEY
BASE=http://localhost:3000/api/v1/managed_agents

# 1. Create an agent (one-time per (model, prompt, repo) combo)
AGENT=$(curl -sX POST $BASE/agents \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{
    "name":"code-reviewer",
    "model":"anthropic/claude-sonnet-4-6",
    "prompt":"You are a senior engineer reviewing code for clarity and security.",
    "repo_url":"https://github.com/BerriAI/litellm",
    "branch":"main"
  }' | jq -r .id)

# 2. Spawn a session — this takes ~50–120s the first time as Fargate boots
SESSION=$(curl -sX POST $BASE/agents/$AGENT/session \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"title":"smoke-test"}' | jq -r .id)

# 3. Talk to it. Body and response are the opencode HTTP API verbatim.
curl -sX POST $BASE/sessions/$SESSION/message \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"text":"What does this repo do? One sentence."}'

# 4. Tear it down (otherwise the reconciler will after 24h idle)
curl -sX DELETE $BASE/sessions/$SESSION -H "Authorization: Bearer $KEY"
```

Same flow from TypeScript:

```ts
const KEY = process.env.MASTER_KEY!;
const BASE = "http://localhost:3000/api/v1/managed_agents";
const auth = { "Authorization": `Bearer ${KEY}`, "content-type": "application/json" };

const agent = await fetch(`${BASE}/agents`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    model: "anthropic/claude-sonnet-4-6",
    prompt: "Concise.",
    repo_url: "https://github.com/BerriAI/litellm",
  }),
}).then(r => r.json());

const session = await fetch(`${BASE}/agents/${agent.id}/session`, {
  method: "POST", headers: auth, body: "{}",
}).then(r => r.json());            // ~50–120s

const reply = await fetch(`${BASE}/sessions/${session.id}/message`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ text: "List the top-level directories." }),
}).then(r => r.json());

await fetch(`${BASE}/sessions/${session.id}`, { method: "DELETE", headers: auth });
```

If you reuse an agent for multiple sessions, agent creation only happens once. `POST /agents/{id}/session` is the slow path — skip it by keeping a session alive between messages.

### The full surface

```
GET    /api/v1/managed_agents/dockerfiles            list available harnesses (currently just opencode)
GET    /api/v1/managed_agents/agents                 list all agents
POST   /api/v1/managed_agents/agents                 create one
GET    /api/v1/managed_agents/agents/{id}            fetch one
PATCH  /api/v1/managed_agents/agents/{id}            update name / pfp / mcp_servers
POST   /api/v1/managed_agents/agents/{id}/session    spin Fargate, optional `initial_prompt`
GET    /api/v1/managed_agents/sessions               list sessions, optional ?agent_id=
GET    /api/v1/managed_agents/sessions/{id}          fetch one
DELETE /api/v1/managed_agents/sessions/{id}          stop the Fargate task
POST   /api/v1/managed_agents/sessions/{id}/message  chat (opencode-compatible body)

# passthroughs to your LiteLLM gateway, for the model + MCP pickers in the UI
GET    /api/v1/models
GET    /api/v1/mcp/server
GET    /api/mcp-rest/tools/list?server_id=...
```
