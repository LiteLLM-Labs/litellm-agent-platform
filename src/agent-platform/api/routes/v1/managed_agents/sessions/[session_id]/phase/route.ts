/**
 * POST /api/v1/managed_agents/sessions/{session_id}/phase
 *
 * In-sandbox harness reports a bring-up phase back to the platform. Called
 * from harnesses/{harness}/entrypoint.sh's `report_phase` helper as the
 * container progresses through container-side work the platform itself
 * can't observe (the `git clone`, `npm install`, "harness is finally
 * listening" moment).
 *
 * Auth model — per-session token, no key management:
 *   - At runTask time, src/api/k8s.ts:buildContainerEnv injects
 *     HARNESS_PROGRESS_TOKEN = SESSION_ID into the container env.
 *   - The handler accepts iff `Authorization: Bearer <token>` matches the
 *     URL's `session_id` exactly. Constant-time-ish compare so timing
 *     can't be used to enumerate session IDs.
 *   - A compromised container can therefore write phase events for its
 *     own session and no other. The blast radius is bounded to the
 *     SessionPhase whitelist below, so even with the token in hand the
 *     attacker can only push one of three string values.
 *
 * Phase whitelist:
 *   Only "cloning_repo", "installing_deps", "harness_listening" are
 *   accepted. Phases the platform owns (creating_sandbox, pod_pending,
 *   pod_running, waiting_harness, harness_ready, ready) are NOT writable
 *   from inside the container — we don't want a buggy harness flipping
 *   the row to `ready` while the platform thinks it's still waiting.
 *
 * Idempotency:
 *   POSTing the same phase twice is a no-op write. Order is not
 *   enforced: the harness is welcome to skip a phase or report the same
 *   phase from multiple call sites.
 */

import { z } from "zod";

import { prisma } from "@/api/db";
import { wrap } from "@/api/route-helpers";
import { httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// Subset of SessionPhase that the in-sandbox harness is allowed to write.
// Keep in lockstep with the actual values reported by entrypoint.sh's
// report_phase calls — if you add a new report site there, add the value
// here and to SessionPhase in src/api/types.ts.
const HARNESS_REPORTABLE_PHASES = [
  "cloning_repo",
  "installing_deps",
  "harness_listening",
] as const;

const PhaseBody = z.object({
  phase: z.enum(HARNESS_REPORTABLE_PHASES),
  detail: z.string().max(500).optional(),
});

// Constant-time-flavoured string compare. Node's `crypto.timingSafeEqual`
// throws on length mismatch — short-circuit on length first so we don't
// leak that, then compare the bytes.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;

  // Auth: bearer == session_id. No master key needed — this endpoint is
  // exclusively for the in-sandbox harness, which only knows its own
  // session_id (injected as HARNESS_PROGRESS_TOKEN at runTask time).
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${session_id}`;
  if (!safeEqual(auth, expected)) {
    httpError(401, "invalid harness progress token");
  }

  const body = PhaseBody.parse(await req.json().catch(() => ({})));

  // Best-effort write. If the row was deleted out from under us (session
  // already terminal, reconciler swept) we 404 — but we don't surface a
  // distinct error for "row missing" vs "row exists but in a phase we
  // can't overwrite" because the harness side treats every response as
  // fire-and-forget anyway.
  try {
    await prisma.session.update({
      where: { session_id },
      data: { phase: body.phase, phase_detail: body.detail ?? null },
    });
  } catch {
    // Either the row is gone or some other DB-level issue. Don't bubble a
    // 500 to the harness — it would just log and continue. Treat the
    // happy and missing paths the same way and let the harness move on.
    return Response.json({ ok: false });
  }

  return Response.json({ ok: true });
});
