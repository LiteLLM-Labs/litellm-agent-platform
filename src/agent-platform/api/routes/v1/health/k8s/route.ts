/**
 * GET /api/v1/health/k8s
 *
 * Lightweight K8s connectivity probe. Makes the same list call reconcile uses
 * as its very first operation — if this returns ok=false, every session create
 * and every reconcile tick will fail for the same reason.
 *
 * Useful for uptime monitors, Render health checks, and catching auth failures
 * (e.g. expired AWS credentials) before users report them.
 */

import { NextResponse } from "next/server";

import { assertAuth } from "@/api/auth";
import { probeK8s } from "@/api/k8s";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";

export const GET = wrap(async (req: Request) => {
  assertAuth(req);

  const start = Date.now();
  const result = await probeK8s();
  const elapsed_ms = Date.now() - start;

  if (result.ok) {
    return NextResponse.json({ ok: true, elapsed_ms });
  }
  return NextResponse.json(
    { ok: false, error: result.error, elapsed_ms },
    { status: 503 },
  );
});
