/**
 * GET  /api/v1/managed_agents/agents/[agent_id]/issues — list issues
 * POST /api/v1/managed_agents/agents/[agent_id]/issues — create issue (used by report_issue MCP)
 *
 * List all issues reported by the agent across all sessions.
 * Optional query params:
 *   ?status=open|resolved|dismissed  (default: all)
 *   ?severity=info|warning|error|critical
 *   ?limit=N  (default 200)
 */

import { assertAgentTokenOrMaster } from "@/api/auth";
import { prisma } from "@/api/db";
import { CreateIssueBody, httpError, toApiIssue, toApiIssueComment } from "@/api/types";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id });

  const exists = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true },
  });
  if (!exists) httpError(404, `agent '${agent_id}' not found`);

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const severity = url.searchParams.get("severity") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 500);

  const rows = await prisma.agentIssue.findMany({
    where: {
      agent_id,
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
    },
    include: { comments: { orderBy: { created_at: "asc" } } },
    orderBy: { created_at: "desc" },
    take: limit,
  });

  return Response.json(
    rows.map((row) => ({
      ...toApiIssue(row),
      comments: row.comments.map(toApiIssueComment),
    })),
  );
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id });

  const exists = await prisma.agent.findUnique({ where: { agent_id }, select: { agent_id: true } });
  if (!exists) httpError(404, `agent '${agent_id}' not found`);

  const raw = await req.json();
  const body = CreateIssueBody.parse(raw);
  const session_id = typeof raw.session_id === "string" ? raw.session_id : null;

  // Dedup: find existing open issue with same title (case-insensitive).
  const existing = await prisma.agentIssue.findFirst({
    where: { agent_id, status: "open", title: { equals: body.title, mode: "insensitive" } },
  });

  if (existing) {
    const commentBody = [body.body, session_id ? `Session: ${session_id}` : null]
      .filter(Boolean).join("\n\n");
    const [updated] = await prisma.$transaction([
      prisma.agentIssue.update({ where: { issue_id: existing.issue_id }, data: { times_seen: { increment: 1 } } }),
      prisma.agentIssueComment.create({ data: { issue_id: existing.issue_id, session_id, body: commentBody } }),
    ]);
    return Response.json(toApiIssue(updated), { status: 200 });
  }

  const issue = await prisma.agentIssue.create({
    data: { agent_id, session_id, title: body.title, body: body.body ?? null, severity: body.severity ?? "info" },
  });
  return Response.json(toApiIssue(issue), { status: 201 });
});
