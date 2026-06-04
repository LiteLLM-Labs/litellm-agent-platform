/**
 * POST /api/v1/agent-auth/refresh
 *
 * Exchange a long-lived refresh token (15min default; ~24h in practice for
 * the per-pod tokens) for a fresh access token. Called by the harness's
 * MCP tool handler when it gets a 401 from a memory route — the handler
 * swaps in the new access token and retries the original call once.
 *
 * The refresh token IS the credential — no Authorization header is required
 * (and one would be redundant; the refresh token's HMAC proves provenance).
 * That's also why this is its own route: every other v1 route under
 * /managed_agents/* takes a bearer, so a brand-new pod would have nothing
 * to send before it gets its first access token rotated.
 *
 * The token's `scope` and `agent_id` mirror what the server originally
 * minted at pod-spawn time — we re-derive them from the refresh token's
 * claims rather than letting the caller pick. Refresh is purely a
 * lifetime extension, not a privilege bump.
 *
 * No DB round trip. Verification is HMAC + `exp` check.
 *
 * Errors:
 *   400 — missing/blank refresh_token
 *   401 — bad signature, expired, or wrong-kind token
 */

import { z, ZodError } from "zod";

import {
  mintAgentAccessToken,
  verifyAgentRefreshToken,
} from "@/api/auth/agent-token";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  refresh_token: z.string().min(1, "refresh_token required"),
});

export const POST = wrap(async (req) => {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }

  const verified = verifyAgentRefreshToken(body.refresh_token);
  if (!verified.ok) {
    // Don't leak which specific check failed — same 401 for expired,
    // bad-signature, wrong-kind. The harness only cares "do I have a
    // working refresh token or do I need to give up?"
    return Response.json({ error: "invalid refresh token" }, { status: 401 });
  }

  // Re-derive the grant from the refresh token's own claims so widening
  // the scope set at pod-spawn time (k8s.ts) is the ONLY place to edit.
  // Anything else risks a silent privilege downgrade on first rotation:
  // a refresh token minted with scope=[A,B] would yield access tokens
  // with only the hardcoded list, causing opaque 403s 15 min later.
  const access_token = mintAgentAccessToken({
    agent_id: verified.claims.agent_id,
    scope: verified.claims.scope,
    pod: verified.claims.pod,
  });

  return Response.json({
    access_token,
    // Lifetime of the access token in seconds, so the caller can preemptively
    // refresh before the next call instead of always waiting for a 401.
    // Mirrors the OAuth2 token-endpoint convention.
    expires_in: 15 * 60,
    token_type: "Bearer",
  });
});
