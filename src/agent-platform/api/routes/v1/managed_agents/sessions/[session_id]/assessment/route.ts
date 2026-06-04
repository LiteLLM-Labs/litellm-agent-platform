/**
 * GET /api/v1/managed_agents/sessions/[session_id]/assessment
 * POST /api/v1/managed_agents/sessions/[session_id]/assessment
 *
 * Returns the latest platform reviewer assessment for a session. POST forces
 * an immediate one-off check; the background worker also polls active
 * sessions once per minute.
 */

import { assertAuth } from "@/api/auth";
import {
  assessAndStoreSession,
  getLatestAssessment,
  toApiSessionAssessment,
} from "@/api/reviewer";
import { wrap } from "@/api/route-helpers";
import { httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  const row = await getLatestAssessment(session_id);
  if (!row) {
    return Response.json(null);
  }
  return Response.json(toApiSessionAssessment(row));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  try {
    const row = await assessAndStoreSession(session_id);
    return Response.json(toApiSessionAssessment(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      httpError(404, msg);
    }
    throw err;
  }
});
