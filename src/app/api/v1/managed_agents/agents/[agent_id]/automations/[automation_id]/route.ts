/**
 * PATCH  /api/v1/managed_agents/agents/:agent_id/automations/:automation_id
 * DELETE /api/v1/managed_agents/agents/:agent_id/automations/:automation_id
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
  params: Promise<{ agent_id: string; automation_id: string }>;
}

const UpdateAutomationBody = z.object({
  name: z.string().max(120).nullable().optional(),
  instruction: z.string().min(1).optional(),
  cron_expr: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, automation_id } = await ctx.params;

  const existing = await prisma.automation.findUnique({
    where: { automation_id },
  });
  if (!existing || existing.agent_id !== agent_id) {
    httpError(404, `automation '${automation_id}' not found`);
  }

  const body = UpdateAutomationBody.parse(await req.json());

  // Re-validate cron_expr and recompute next_run_at if the expression changed.
  let next_run_at = existing.next_run_at;
  const exprChanged = body.cron_expr !== undefined && body.cron_expr !== existing.cron_expr;
  const nowEnabled = body.enabled === true && !existing.enabled;

  if (body.cron_expr !== undefined) {
    const cronError = validateCronExpr(body.cron_expr);
    if (cronError) httpError(422, cronError);
  }

  if (exprChanged || nowEnabled) {
    // Recompute from the new (or existing) expression.
    next_run_at = nextRunAt(body.cron_expr ?? existing.cron_expr);
  }

  const updated = await prisma.automation.update({
    where: { automation_id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
      ...(body.cron_expr !== undefined ? { cron_expr: body.cron_expr } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      next_run_at,
    },
  });

  return Response.json(updated);
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, automation_id } = await ctx.params;

  const existing = await prisma.automation.findUnique({
    where: { automation_id },
  });
  if (!existing || existing.agent_id !== agent_id) {
    httpError(404, `automation '${automation_id}' not found`);
  }

  await prisma.automation.delete({ where: { automation_id } });

  return Response.json({ deleted: 1 });
});
