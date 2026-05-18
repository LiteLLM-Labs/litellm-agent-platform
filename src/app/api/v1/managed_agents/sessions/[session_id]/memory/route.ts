/**
 * In-sandbox memory access for the calling session's agent.
 *
 * GET   — list or grep this session's agent memory.
 *         Optional ?q=foo (case-insensitive ILIKE on text) and
 *         ?tag=ui (filter to rows whose `tags` includes "ui").
 *         GET also bumps times_applied / last_applied_at on returned rows
 *         — calling GET ?q= is what the harness's search_memory tool does,
 *         and we want usage tracking accurate.
 *
 * POST  — create a new memory for this session's agent. Always recorded
 *         as source="agent" with source_session_id=<this session>; the
 *         caller's claims on those fields are ignored (the caller IS the
 *         agent — server-derived is the only honest answer).
 *
 * Auth model — per-session token, identical to /sessions/.../phase:
 *   - At runTask time, k8s.ts:buildContainerEnv injects
 *     HARNESS_PROGRESS_TOKEN = SESSION_ID into the container env.
 *   - The handler accepts iff `Authorization: Bearer <token>` matches the
 *     URL's `session_id` exactly. Constant-time compare so timing leaks
 *     can't be used to enumerate session IDs.
 *   - A compromised container can therefore read/write memory for its
 *     OWN agent and no other — agent_id is resolved server-side from the
 *     session row, never read from the URL or body.
 *
 * Why this exists alongside /agents/{agent_id}/memory:
 *   The /agents/... route is admin-authenticated (assertAuth — master key
 *   or session cookie). It's used by the UI dashboard and Slack
 *   `remember:` integration. This route is the sandbox harness's
 *   call-back path; it must not require master-key creds in the pod, and
 *   must not let a compromised pod touch other agents' memory.
 */

import { prisma } from "@/server/db";
import { safeEqual } from "@/server/integrations/core/crypto";
import { saveMemory, searchMemory } from "@/server/memory";
import { wrap } from "@/server/route-helpers";
import { CreateMemoryBody, httpError, toApiMemory } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

/**
 * Validate the bearer-token-equals-session-id auth, then look up agent_id
 * server-side. Returns the resolved agent_id or throws (401/404).
 */
async function authAndResolveAgent(
  req: Request,
  session_id: string,
): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${session_id}`;
  if (!safeEqual(auth, expected)) {
    httpError(401, "invalid harness session token");
  }
  const session = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (session === null) httpError(404, `session '${session_id}' not found`);
  // Non-null after the throw above; assert to satisfy TS.
  return session!.agent_id;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const agent_id = await authAndResolveAgent(req, session_id);

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const rows = await searchMemory(agent_id, { q, tag });
  return Response.json(rows.map(toApiMemory));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const agent_id = await authAndResolveAgent(req, session_id);

  // The body is the same shape as the admin POST, but `source` and
  // `source_session_id` are SERVER-DERIVED here — we know exactly which
  // agent and session this came from, so we don't trust the caller's
  // claims on those fields. `source_user_id` / `source_thread_ts` are
  // never meaningful for an in-sandbox write; pinned to null.
  const body = CreateMemoryBody.parse(await req.json());
  const row = await saveMemory({
    agent_id,
    text: body.text,
    tags: body.tags,
    type: body.type,
    priority: body.priority,
    source: "agent",
    source_session_id: session_id,
    source_user_id: null,
    source_thread_ts: null,
  });
  return Response.json(toApiMemory(row));
});
