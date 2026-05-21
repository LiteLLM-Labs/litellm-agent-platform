/**
 * GET  /api/v1/admin/inline-harness  — status of the shared brain-inline harness Deployment
 * POST /api/v1/admin/inline-harness  — enable (creates Deployment+Service) or disable (deletes them)
 *
 * Body: { enable: boolean }
 */

import { assertAuth } from "@/server/auth";
import { env } from "@/server/env";
import {
  createInlineHarnessDeployment,
  deleteInlineHarnessDeployment,
  getInlineHarnessStatus,
} from "@/server/k8s";
import { wrap } from "@/server/route-helpers";
import { HARNESS_CLAUDE_SDK, resolveHarnessImage } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req: Request) => {
  assertAuth(req);
  const status = await getInlineHarnessStatus();
  return Response.json(status);
});

export const POST = wrap(async (req: Request) => {
  assertAuth(req);

  const body = (await req.json()) as { enable?: boolean };
  if (typeof body.enable !== "boolean") {
    return Response.json({ error: "body.enable must be boolean" }, { status: 400 });
  }

  if (body.enable) {
    const image = resolveHarnessImage(HARNESS_CLAUDE_SDK, env);
    await createInlineHarnessDeployment(image);
  } else {
    await deleteInlineHarnessDeployment();
  }

  const status = await getInlineHarnessStatus();
  return Response.json(status);
});
