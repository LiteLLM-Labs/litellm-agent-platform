/**
 * /api/v1/managed_agents/agents/{agent_id}/memory
 *
 * GET   — list or grep this agent's memory.
 *         Optional ?q=foo (case-insensitive ILIKE on text) and
 *         ?tag=ui (filter to rows whose `tags` includes "ui").
 *         Either present narrows; both present intersect.
 *         GET also bumps times_applied / last_applied_at on returned rows
 *         — calling `GET ?q=` is what the harness's search_memory tool does,
 *         and we want usage tracking accurate.
 *
 * POST  — create a new memory. `source` defaults to "ui"; the harness sets
 *         "agent" explicitly and shin sets "slack" when forwarding a
 *         `remember:` Slack message.
 *
 * Both routes invalidate warm tasks for this agent on write so the
 * pre-loaded AGENT_PROMPT picks up the new memory on next launch.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  CreateMemoryBody,
  httpError,
  toApiMemory,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import { saveMemory, searchMemory } from "@/server/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const exists = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true },
  });
  if (exists === null) httpError(404, `agent '${agent_id}' not found`);

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const rows = await searchMemory(agent_id, { q, tag });
  return Response.json(rows.map(toApiMemory));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const exists = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true },
  });
  if (exists === null) httpError(404, `agent '${agent_id}' not found`);

  const body = CreateMemoryBody.parse(await req.json());
  const row = await saveMemory({
    agent_id,
    text: body.text,
    tags: body.tags,
    type: body.type,
    priority: body.priority,
    source: body.source ?? "ui",
    source_user_id: body.source_user_id ?? null,
    source_session_id: body.source_session_id ?? null,
    source_thread_ts: body.source_thread_ts ?? null,
  });
  return Response.json(toApiMemory(row));
});
