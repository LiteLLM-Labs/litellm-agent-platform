/**
 * GET /api/v1/managed_agents/sessions/[session_id]/events
 *
 * Long-poll read endpoint over the persisted SessionEvent log. Replaces the
 * old SSE bus-tail with a plain HTTP cursor: callers track the highest seq
 * they've seen and pass it back as `since`; the server returns any newer
 * events from the log immediately, or waits up to `wait` seconds for the
 * next batch to arrive.
 *
 * Query params:
 *   since (int, default 0) — exclusive cursor; only events with seq > since
 *   wait  (int seconds, default 0, max 30) — long-poll timeout when no
 *                                            events are available right now
 *
 * Response:
 *   { events: ApiSessionEvent[], next_since: number }
 *
 * `next_since` is the max seq of the returned batch (or the input `since`
 * if the batch is empty), suitable for the caller to feed back unchanged
 * on the next request.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { waitForEventsSince } from "@/server/sessionEvents";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// Hard upper bound on the long-poll wait. Anything longer just keeps a
// serverless function pinned for no benefit — clients should reissue.
const MAX_WAIT_SECONDS = 30;

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({ where: { session_id } });
    if (!row) httpError(404, `session ${session_id} not found`);

    const url = new URL(req.url);
    const since = parseIntParam(
      url.searchParams.get("since"),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const wait = parseIntParam(
      url.searchParams.get("wait"),
      0,
      0,
      MAX_WAIT_SECONDS,
    );

    const events = await waitForEventsSince(session_id, since, wait * 1000);
    const next_since =
      events.length > 0 ? events[events.length - 1].seq : since;

    return Response.json({ events, next_since });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
