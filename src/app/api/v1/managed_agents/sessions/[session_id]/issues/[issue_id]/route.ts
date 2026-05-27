/**
 * PATCH /api/v1/managed_agents/sessions/[session_id]/issues/[issue_id]
 *
 * Update status or severity of an issue. Resolves agent_id from the session
 * row so callers only need session_id — no agent_id required.
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { UpdateIssueBody, httpError, toApiIssue } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; issue_id: string }>;
}

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  const { session_id, issue_id } = await ctx.params;

  const sessionRow = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (!sessionRow) httpError(404, `session '${session_id}' not found`);

  assertAgentTokenOrMaster(req, { scope: "issues", agent_id: sessionRow!.agent_id });

  const existing = await prisma.agentIssue.findUnique({
    where: { issue_id },
    select: { agent_id: true },
  });
  if (!existing || existing.agent_id !== sessionRow!.agent_id) {
    httpError(404, `issue '${issue_id}' not found`);
  }

  const body = UpdateIssueBody.parse(await req.json());
  const updated = await prisma.agentIssue.update({
    where: { issue_id },
    data: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.severity !== undefined ? { severity: body.severity } : {}),
    },
  });

  return Response.json(toApiIssue(updated));
});
