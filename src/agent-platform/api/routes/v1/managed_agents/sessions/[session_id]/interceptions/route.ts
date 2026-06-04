/**
 * GET /api/v1/managed_agents/sessions/[session_id]/interceptions
 *
 * Returns the recent credential swaps performed by the vault sidecar in the
 * sandbox pod backing `session_id`. Pure debugging affordance — the user is
 * answering "did vault swap my stub on this tool call?". Records are
 * scrubbed at the source: each entry carries the stub name, the credential
 * name (e.g. GITHUB_TOKEN), and the last 2 characters of the real value as
 * a fingerprint. The full real value is never returned, never logged.
 *
 * Empty-body cases (intentionally 200 with `[]`, not error):
 *   - Session row exists but `task_arn` is null (bring-up scheduled the row
 *     but hasn't called runTask yet).
 *   - Pod exists but doesn't have an IP yet (still scheduling).
 *   - Transient k8s blip or vault not yet listening — surface as empty
 *     rather than a red error in the UI, which polls every ~3s.
 *
 * The UI polls this on a 3s interval — keep the handler cheap.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { fetchVaultInterceptions } from "@/api/k8s";
import { HttpError, httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { task_arn: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    // No pod yet — return empty array so the UI shows the empty state with
    // no flicker. Polling will pick up records as soon as the pod boots.
    if (!row.task_arn) return json([]);

    try {
      const data = await fetchVaultInterceptions(row.task_arn);
      // `null` means the pod doesn't have an IP yet — same empty surface.
      return json(data ?? []);
    } catch (err) {
      // Don't 500 on transient errors. The UI polls every ~3s and a red
      // error overlay flickering past while the pod boots is more
      // confusing than a momentarily-stale table. Log it so we can spot
      // persistent failures in stdout.
      console.warn(
        `interceptions: fetchVaultInterceptions(${row.task_arn}) failed for session ${session_id}:`,
        err,
      );
      return json([]);
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
