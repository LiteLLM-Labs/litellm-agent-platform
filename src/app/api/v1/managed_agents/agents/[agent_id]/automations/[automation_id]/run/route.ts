/**
 * POST /api/v1/managed_agents/agents/{agent_id}/automations/{automation_id}/run
 *
 * Fire an automation immediately, ignoring its schedule — the "Run now" testing
 * button. Records a run and returns it (running, or failed if the spawn failed).
 * Does not change the automation's next_run_at; the normal schedule continues.
 */

import { assertAuth } from "@/server/auth";
import { runAutomationNow } from "@/server/automations";
import { prisma } from "@/server/db";
import { httpError, toApiAutomationRun } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; automation_id: string }>;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, automation_id } = await ctx.params;

  const auto = await prisma.automation.findUnique({ where: { automation_id } });
  if (auto === null || auto.agent_id !== agent_id) {
    httpError(404, `automation '${automation_id}' not found`);
  }

  const run = await runAutomationNow(automation_id);
  if (run === null) {
    httpError(404, `automation '${automation_id}' not found`);
  }
  return Response.json(toApiAutomationRun(run!, { name: auto!.name }), {
    status: 201,
  });
});
