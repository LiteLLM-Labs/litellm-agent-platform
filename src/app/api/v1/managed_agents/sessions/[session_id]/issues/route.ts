/**
 * POST /api/v1/managed_agents/sessions/[session_id]/issues
 *
 * Creates a new issue OR deduplicates against an existing open issue with the
 * same title (case-insensitive). On match: increments times_seen, appends a
 * comment with the new body+session context, returns 200. On no match:
 * creates fresh issue, returns 201.
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { CreateIssueBody, httpError, toApiIssue } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;

  const sessionRow = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (!sessionRow) httpError(404, `session '${session_id}' not found`);

  assertAgentTokenOrMaster(req, { scope: "issues", agent_id: sessionRow!.agent_id });

  const body = CreateIssueBody.parse(await req.json());

  // Dedup: find existing open issue with same title (case-insensitive).
  const existing = await prisma.agentIssue.findFirst({
    where: {
      agent_id: sessionRow!.agent_id,
      status: "open",
      title: { equals: body.title, mode: "insensitive" },
    },
  });

  if (existing) {
    // Increment counter + append comment with session context.
    const commentBody = [
      body.body ? body.body : null,
      `Session: ${session_id}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const [updated] = await prisma.$transaction([
      prisma.agentIssue.update({
        where: { issue_id: existing.issue_id },
        data: { times_seen: { increment: 1 } },
      }),
      prisma.agentIssueComment.create({
        data: {
          issue_id: existing.issue_id,
          session_id,
          body: commentBody,
        },
      }),
    ]);

    return Response.json(toApiIssue(updated), { status: 200 });
  }

  // New issue.
  const issue = await prisma.agentIssue.create({
    data: {
      agent_id: sessionRow!.agent_id,
      session_id,
      title: body.title,
      body: body.body ?? null,
      severity: body.severity ?? "info",
    },
  });

  return Response.json(toApiIssue(issue), { status: 201 });
});
