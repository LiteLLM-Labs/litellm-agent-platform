# Automations

Automations run an agent on a recurring schedule. Each automation is a cron
schedule plus an instruction; when it fires, the platform **starts a fresh
session for the agent with that instruction as the initial prompt** — exactly
as if a user had spawned a session and typed it. Runs are stateless: no chat
history carries from one run to the next.

## How a run happens

```
Automation (cron + instruction)
        │  worker tick (~every RECONCILE_INTERVAL_SECONDS, default 60s)
        ▼
tickAutomations()  ── claims due rows, advances next_run_at ──┐
        │                                                     │ (same DB txn)
        ▼                                                     │
POST /v1/managed_agents/agents/:id/session  ◄────────────────┘
   { initial_prompt: <instruction>, title: "[auto] <name>" }
        │  reuses warm-pool / cold-spawn bring-up
        ▼
Session runs the instruction · AutomationRun row records the outcome
```

1. The **worker** (`litellm-worker`) ticks on a fixed interval.
2. `tickAutomations()` selects automations that are `enabled` and whose
   `next_run_at <= now`, claims them with `SELECT … FOR UPDATE SKIP LOCKED`,
   and — in the same transaction — advances each `next_run_at` to its next
   occurrence. This is what makes it **multi-pod safe**: two workers ticking at
   the same instant can't double-fire, because the second one's `SKIP LOCKED`
   skips the row the first is holding, and once that commits the next fire time
   is in the future.
3. Outside the transaction (so the row lock stays short), each due automation
   spawns a session via the normal session-create route, authenticated
   in-process with the platform `MASTER_KEY`.
4. Every fire writes an `AutomationRun` row (`running`), which a later worker
   tick resolves to `succeeded` / `failed` by inspecting the spawned session.

Schedules are standard **5-field cron evaluated in UTC**. `next_run_at` is
pre-computed on create/update so the worker query is a plain range scan — no
cron parsing at query time. A schedule with no future occurrence (e.g.
`0 9 31 2 *`) is rejected at the API and disabled if it ever exhausts.

## Who can create them

- **Users**, via the Automations section on the agent page (`/agents/:id`) —
  pick a preset cadence (or a custom cron) and an instruction.
- **The agent itself**, via the `create_automation` / `list_automations` tools
  (see [managed-tools](../managed-tools/README.md)). When a user tells the
  agent "do this every day at 9am", the agent schedules it and reports back.
  Agent-created rows are attributed `created_by = "agent"`.

## API

All under `/api/v1/managed_agents/agents/:id`. Accept the master key; the
list/create routes also accept a scoped agent token (`automations` scope).

| Method | Path | Action |
|--------|------|--------|
| `GET`    | `/automations`                 | list automations |
| `POST`   | `/automations`                 | create (validates cron, sets `next_run_at`) |
| `PATCH`  | `/automations/:automation_id`  | update name / instruction / cron / enabled |
| `DELETE` | `/automations/:automation_id`  | delete |
| `GET`    | `/automation-runs`             | run log, newest first (`?limit=`, default 50) |

## Data model

`Automation` (`managed_agent_automation`) — one schedule:
`instruction`, `cron_expr`, `enabled`, pre-computed `next_run_at`, `last_run_at`.

`AutomationRun` (`managed_agent_automation_run`) — one row per fire:
`session_id`, `status` (`running` | `succeeded` | `failed`), `error`,
`started_at`, `finished_at`.

Both cascade-delete with their agent.

## Where the code lives

| Concern | File |
|---------|------|
| Cron helpers, worker tick, run reconcile | `src/server/automations.ts` |
| API routes | `src/app/api/v1/managed_agents/agents/[agent_id]/automations/` and `/automation-runs/` |
| Worker wiring | `src/worker/index.ts` |
| UI (list + add form) | `src/components/automations-section.tsx` |
| UI (run log) | `src/components/automation-runs-section.tsx` |
| Agent tool spec | `managed-tools/src/automations.ts` |
| Harness adapter | `harnesses/claude-agent-sdk/src/automations-tools.ts` |
| Schema | `prisma/schema.prisma` (`Automation`, `AutomationRun`) |
