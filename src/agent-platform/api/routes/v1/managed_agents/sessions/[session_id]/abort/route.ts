/**
 * POST /api/v1/managed_agents/sessions/[session_id]/abort
 *
 * Signals the harness to abort the in-flight agent turn. The harness calls
 * AbortController.abort() on the Claude SDK query(), which stops tool
 * execution mid-run and returns an AbortError result to the caller.
 *
 * Returns 200 {ok:true} when the signal was delivered (or when there was no
 * in-flight turn — the harness is idempotent). Returns 404 when the session
 * doesn't exist or isn't ready (no sandbox to signal).
 */

import { assertAuth } from "@/api/auth";
import { getCachedSession } from "@/api/sessionCache";
import { harnessAbort } from "@/api/harness";
import { HttpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const cached = await getCachedSession(session_id);
    if (!cached) {
      return Response.json(
        { error: `session ${session_id} not found or not ready` },
        { status: 404 },
      );
    }

    await harnessAbort({
      sandbox_url: cached.sandbox_url,
      harness_session_id: cached.harness_session_id,
    });

    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error("abort route error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
