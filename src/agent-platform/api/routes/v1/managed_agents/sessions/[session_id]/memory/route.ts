/**
 * /api/v1/managed_agents/sessions/{session_id}/memory
 *
 * Session-scoped wrapper over /agents/{agent_id}/memory, for the SHARED inline
 * harness. That harness runs one `opencode serve` process for every agent, so
 * it has no per-agent AGENT_ID in env and can't target an agent's memory the
 * usual way. Here the harness passes the session_id it already has (injected as
 * <lap_session_id>); we resolve the session's agent_id server-side and reuse
 * the exact same searchMemory/saveMemory helpers as the agent-scoped route.
 *
 * GET  — search this session's agent's memory (?q=, ?tag=)
 * POST — save memory for this session's agent
 *
 * Auth: assertAuth (MASTER_KEY) — same as the sibling /sandbox/* session routes.
 */

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { CreateMemoryBody, httpError, toApiMemory } from "@/api/types";
import { wrap } from "@/api/route-helpers";
import { saveMemory, searchMemory } from "@/api/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

async function resolveAgentId(session_id: string): Promise<string> {
  const row = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (row === null) httpError(404, `session '${session_id}' not found`);
  return row.agent_id;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  const agent_id = await resolveAgentId(session_id);

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const rows = await searchMemory(agent_id, { q, tag });
  return Response.json(rows.map(toApiMemory));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  const agent_id = await resolveAgentId(session_id);

  const body = CreateMemoryBody.parse(await req.json());
  const row = await saveMemory({
    agent_id,
    text: body.text,
    tags: body.tags,
    type: body.type,
    priority: body.priority,
    pinned: body.pinned,
    source: body.source ?? "agent",
    source_user_id: body.source_user_id ?? null,
    source_session_id: body.source_session_id ?? session_id,
    source_thread_ts: body.source_thread_ts ?? null,
  });
  return Response.json(toApiMemory(row));
});
