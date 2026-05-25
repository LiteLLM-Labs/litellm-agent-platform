/**
 * POST /api/v1/managed_agents/sessions/[session_id]/artifacts
 *
 * Harness-facing upload endpoint. The pod posts a base64-encoded file plus
 * its declared size + mime type; we put it in S3 under
 * `artifacts/{session_id}/{uuid}/{name}` and return a 7-day presigned URL
 * the agent can hand back to the user.
 *
 * Auth: scoped agent token (`scope: "artifacts"`) bound to the session's
 * agent_id, or the master key (for UI/CLI parity). Master-key-only access
 * is intentionally not the primary path — that was the failure mode this
 * route's earlier auth scheme accidentally fell into.
 */

import { z } from "zod";

import { createArtifact } from "@/server/artifacts";
import { prisma } from "@/server/db";
import { assertAgentTokenOrMaster } from "@/server/auth";
import { env } from "@/server/env";
import { httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// Base64 expands the original byte count by ~33% (4 base64 chars per 3
// raw bytes), so to allow a 100 MB binary artifact we need to accept up
// to ~134 MB of base64 string. Decoded-byte cap is enforced separately
// inside `createArtifact`.
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BINARY_BYTES * 4 / 3) + 4;

const CreateArtifactSchema = z.object({
  name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(255),
  content: z.string().min(1).max(MAX_BASE64_CHARS),
  size: z.number().int().min(1).max(MAX_BINARY_BYTES),
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;

  // Storage feature flag: when ARTIFACT_STORAGE or AWS_S3_BUCKET is unset
  // the route is effectively disabled. 503 makes the harness retry/fall
  // back gracefully instead of treating it as a 404 (which would suggest
  // the session is gone).
  if (!env.ARTIFACT_STORAGE || !env.AWS_S3_BUCKET) {
    httpError(503, "artifact storage not configured");
  }

  // Look up the session up front for two reasons:
  //   1. We need its `agent_id` to bind the auth check to the same agent
  //      the pod's token was issued for (assertAgentTokenOrMaster wants
  //      `agent_id`, not `session_id`).
  //   2. We need its `status` so we don't accept uploads against
  //      sessions that never came up or have been torn down.
  const session = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true, status: true },
  });
  if (!session) httpError(404, `session '${session_id}' not found`);

  assertAgentTokenOrMaster(req, {
    scope: "artifacts",
    agent_id: session!.agent_id,
  });

  if (session!.status !== "ready") {
    httpError(400, `session '${session_id}' is not ready (status=${session!.status})`);
  }

  const body = CreateArtifactSchema.parse(await req.json());

  const artifact = await createArtifact({
    session_id,
    name: body.name,
    mime_type: body.mime_type,
    content: body.content,
    size: body.size,
  });

  return Response.json(artifact, { status: 201 });
});
