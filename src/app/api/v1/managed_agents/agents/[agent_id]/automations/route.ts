/**
 * /api/v1/managed_agents/agents/{agent_id}/automations
 *
 * GET   — list this agent's automations, soonest-due first.
 * POST  — create one. Validates the cron expression (CreateAutomationBody)
 *         and pre-computes next_run_at so the worker query stays a plain
 *         range scan. A disabled automation gets a null next_run_at so it's
 *         never claimed until re-enabled.
 *
 * Auth: master key (UI) OR a scoped agent token (scope "automations"), so the
 * in-sandbox agent can list/create its own schedules via the managed-tools
 * create_automation / list_automations tools.
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { computeNextRunAt } from "@/server/automations";
import { prisma } from "@/server/db";
import {
  CreateAutomationBody,
  httpError,
  toApiAutomation,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "automations", agent_id });
  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const rows = await prisma.automation.findMany({
    where: { agent_id },
    orderBy: [{ next_run_at: "asc" }, { created_at: "desc" }],
  });
  return Response.json(rows.map(toApiAutomation));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id } = await ctx.params;
  const identity = assertAgentTokenOrMaster(req, {
    scope: "automations",
    agent_id,
  });
  const body = CreateAutomationBody.parse(await req.json());

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const enabled = body.enabled ?? true;
  // Only schedule a fire when enabled; a disabled row sits with a null
  // next_run_at and is skipped by the worker until it's turned on.
  const nextRunAt = enabled ? computeNextRunAt(body.cron_expr) : null;
  // A cron can be syntactically valid yet never occur (e.g. "0 9 31 2 *" —
  // Feb 31). Reject up front so the user gets feedback instead of an
  // automation that shows "Enabled" but never fires.
  if (enabled && nextRunAt === null) {
    httpError(422, "cron expression has no future occurrences");
  }
  const created = await prisma.automation.create({
    data: {
      agent_id,
      instruction: body.instruction,
      cron_expr: body.cron_expr,
      name: body.name ?? null,
      enabled,
      next_run_at: nextRunAt,
      // "agent" when the in-sandbox agent scheduled itself, "ui" for the master key.
      created_by: identity.source === "agent" ? "agent" : "ui",
    },
  });
  return Response.json(toApiAutomation(created), { status: 201 });
});
