/**
 * GET /api/v1/managed_agents/agents/{agent_id}/automation-runs/{run_id}
 *
 * One run with its automation's name/instruction/cron, for the run detail page.
 * Scoped by agent_id so a run_id from another agent reads as 404.
 */

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { httpError, toApiAutomationRun } from "@/api/types";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; run_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, run_id } = await ctx.params;

  const run = await prisma.automationRun.findUnique({
    where: { run_id },
    include: {
      automation: { select: { name: true, instruction: true, cron_expr: true } },
    },
  });
  if (run === null || run.agent_id !== agent_id) {
    httpError(404, `automation run '${run_id}' not found`);
  }

  return Response.json(
    toApiAutomationRun(run!, {
      name: run!.automation?.name ?? null,
      instruction: run!.automation?.instruction,
      cron_expr: run!.automation?.cron_expr,
    }),
  );
});
