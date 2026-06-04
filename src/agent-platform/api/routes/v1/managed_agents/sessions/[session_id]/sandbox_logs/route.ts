/**
 * GET /api/v1/managed_agents/sessions/[session_id]/sandbox_logs
 *
 * Returns the raw stdout+stderr of the harness pod backing `session_id` so
 * the UI can render a "sandbox terminal" panel while the session is in
 * `creating` state (and a final snapshot for `failed`). This is purely a
 * debugging affordance — there's no streaming, no filtering, no parsing.
 * Just the same bytes a `kubectl logs` would emit.
 *
 * Empty-body cases (intentionally 200, not error):
 *   - Session row exists but `task_arn` is null (bring-up scheduled the row
 *     but hasn't called runTask yet).
 *   - Sandbox CR exists but the agent-sandbox controller hasn't stamped the
 *     pod yet (the K8s log API returns NotFound; `readPodLogs` swallows it).
 *
 * The UI is expected to poll this on a short interval (~1.5s) — bounded by
 * `sinceSeconds` and `tailLines` query params so each tick stays cheap.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { readPodLogs } from "@/api/k8s";
import { HttpError, httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap query inputs so a stray client can't ask for an unbounded log window.
// Defaults pick a useful slice for the creating-state UI (10 min, 500 lines).
const DEFAULT_SINCE_SECONDS = 600;
const MAX_SINCE_SECONDS = 3600;
const DEFAULT_TAIL_LINES = 500;
const MAX_TAIL_LINES = 5000;

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

/**
 * Parse a non-negative integer query param, clamping to [1, max]. Returns
 * `fallback` when the param is missing or unparseable.
 */
function parseBoundedInt(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function plainText(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const url = new URL(req.url);
    const sinceSeconds = parseBoundedInt(
      url.searchParams.get("sinceSeconds"),
      DEFAULT_SINCE_SECONDS,
      MAX_SINCE_SECONDS,
    );
    const tailLines = parseBoundedInt(
      url.searchParams.get("tailLines"),
      DEFAULT_TAIL_LINES,
      MAX_TAIL_LINES,
    );

    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { task_arn: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    // The session row was created but runTask hasn't recorded a task_arn yet
    // (or the row was reset on a restart). The pod doesn't exist to read,
    // so return empty text — the UI keeps polling and will start seeing
    // output as soon as runTask updates the row.
    if (!row.task_arn) return plainText("");

    try {
      const text = await readPodLogs(row.task_arn, {
        sinceSeconds,
        tailLines,
      });
      return plainText(text);
    } catch (err) {
      // Don't 500 on transient K8s API blips during cold spawn — the UI
      // polls every ~1.5s and would just flash a red error. Surface as a
      // 200 with a marker line so the user sees that something happened.
      console.warn(
        `sandbox_logs: readPodLogs(${row.task_arn}) failed for session ${session_id}:`,
        err,
      );
      const detail = err instanceof Error ? err.message : String(err);
      return plainText(`[sandbox_logs] transient read error: ${detail}\n`);
    }
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
