/**
 * GET   /api/v1/managed_agents/agents/[agent_id]/issues/[issue_id]
 * PATCH /api/v1/managed_agents/agents/[agent_id]/issues/[issue_id]
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { UpdateIssueBody, httpError, toApiIssue, toApiIssueComment } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; issue_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id, issue_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id });

  const row = await prisma.agentIssue.findUnique({
    where: { issue_id },
    include: { comments: { orderBy: { created_at: "asc" } } },
  });
  if (!row || row.agent_id !== agent_id) httpError(404, `issue '${issue_id}' not found`);

  return Response.json({ ...toApiIssue(row!), comments: row!.comments.map(toApiIssueComment) });
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id, issue_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id });

  const existing = await prisma.agentIssue.findUnique({ where: { issue_id }, select: { agent_id: true } });
  if (!existing || existing.agent_id !== agent_id) httpError(404, `issue '${issue_id}' not found`);

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
