/**
 * GET  /api/v1/managed_agents/sessions/[session_id]/issues — list agent issues (session-scoped auth)
 * POST /api/v1/managed_agents/sessions/[session_id]/issues — create/dedup issue
 *
 * Both routes resolve agent_id from the session row so callers only need session_id.
 * GET returns all issues for the agent (not just this session) — same view as the
 * agent-scoped GET, just authenticated via session_id.
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { CreateIssueBody, httpError, toApiIssue, toApiIssueComment } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

async function resolveSession(session_id: string) {
  const row = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (!row) httpError(404, `session '${session_id}' not found`);
  return row!;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const sessionRow = await resolveSession(session_id);
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id: sessionRow.agent_id });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const severity = url.searchParams.get("severity") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 500);

  const rows = await prisma.agentIssue.findMany({
    where: {
      agent_id: sessionRow.agent_id,
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
    },
    include: { comments: { orderBy: { created_at: "asc" } } },
    orderBy: { created_at: "desc" },
    take: limit,
  });

  return Response.json(
    rows.map((row) => ({ ...toApiIssue(row), comments: row.comments.map(toApiIssueComment) })),
  );
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;

  const sessionRow = await resolveSession(session_id);
  assertAgentTokenOrMaster(req, { scope: "issues", agent_id: sessionRow.agent_id });

  const body = CreateIssueBody.parse(await req.json());

  // Dedup: find existing open issue with same title (case-insensitive).
  const existing = await prisma.agentIssue.findFirst({
    where: {
      agent_id: sessionRow.agent_id,
      status: "open",
      title: { equals: body.title, mode: "insensitive" },
    },
  });

  if (existing) {
    const commentBody = [body.body ? body.body : null, `Session: ${session_id}`]
      .filter(Boolean)
      .join("\n\n");

    const [updated] = await prisma.$transaction([
      prisma.agentIssue.update({
        where: { issue_id: existing.issue_id },
        data: { times_seen: { increment: 1 } },
      }),
      prisma.agentIssueComment.create({
        data: { issue_id: existing.issue_id, session_id, body: commentBody },
      }),
    ]);

    return Response.json(toApiIssue(updated), { status: 200 });
  }

  const issue = await prisma.agentIssue.create({
    data: {
      agent_id: sessionRow.agent_id,
      session_id,
      title: body.title,
      body: body.body ?? null,
      severity: body.severity ?? "info",
    },
  });

  return Response.json(toApiIssue(issue), { status: 201 });
});
