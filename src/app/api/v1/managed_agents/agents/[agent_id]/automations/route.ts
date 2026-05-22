/**
 * GET  /api/v1/managed_agents/agents/:agent_id/automations  — list
 * POST /api/v1/managed_agents/agents/:agent_id/automations  — create
 */

import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";
import { nextRunAt, validateCronExpr } from "@/server/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

const CreateAutomationBody = z.object({
  name: z.string().max(120).optional(),
  instruction: z.string().min(1, "instruction is required"),
  cron_expr: z.string().min(1, "cron_expr is required"),
  enabled: z.boolean().optional().default(true),
});

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (!agent) httpError(404, `agent '${agent_id}' not found`);

  const automations = await prisma.automation.findMany({
    where: { agent_id },
    orderBy: { created_at: "asc" },
  });

  return Response.json({ data: automations });
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (!agent) httpError(404, `agent '${agent_id}' not found`);

  const body = CreateAutomationBody.parse(await req.json());

  const cronError = validateCronExpr(body.cron_expr);
  if (cronError) httpError(422, cronError);

  const next_run_at = nextRunAt(body.cron_expr);

  const automation = await prisma.automation.create({
    data: {
      agent_id,
      name: body.name ?? null,
      instruction: body.instruction,
      cron_expr: body.cron_expr,
      enabled: body.enabled,
      next_run_at,
      created_by: identity.user_id,
    },
  });

  return Response.json(automation, { status: 201 });
});
