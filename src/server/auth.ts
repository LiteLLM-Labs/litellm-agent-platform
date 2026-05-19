/**
 * Bearer auth for v0 single-tenant UI.
 * See AuthIdentity / assertAuth / expectedBearer in src/server/types.ts.
 *
 * Two auth paths coexist:
 *   1. MASTER_KEY bearer — used by the web UI, the `lap` CLI, and any
 *      operator script. Grants full access to every route.
 *   2. Per-pod agent access tokens (HMAC, see auth/agent-token.ts) — used
 *      by the harness running inside a sandbox pod. Scoped to a single
 *      agent's resources and to a specific route class (today: "memory").
 *
 * Routes that should accept BOTH call `assertAgentTokenOrMaster` (and have
 * access to the URL's `agent_id`). Routes only reachable by the UI/CLI
 * call the older `assertAuth`, which only accepts MASTER_KEY.
 */

import { timingSafeEqual } from "node:crypto";
import {
  verifyAgentAccessToken,
  type AgentScope,
} from "@/server/auth/agent-token";
import { env } from "@/server/env";
import type { AuthIdentity } from "@/server/types";

let cachedExpected: string | null = null;

/**
 * Name of the HttpOnly cookie that mirrors the bearer master key for SSE
 * routes the browser opens via `EventSource` (which can't attach an
 * Authorization header). Set by POST /api/ui/auth/cookie after a successful
 * /login submit; read by `assertCookieAuth` on the /api/ui SSE proxy.
 *
 * Single-tenant v0: same MASTER_KEY value as Bearer, just delivered via a
 * cookie envelope. HttpOnly + SameSite=Lax + Secure-in-prod keeps it out
 * of script reach (matches the security profile of the bearer-in-Authorization
 * header that other v1 routes use).
 */
export const UI_COOKIE_NAME = "__lap_master_key";

export function expectedBearer(): string {
  if (cachedExpected === null) {
    cachedExpected = `Bearer ${env.MASTER_KEY}`;
  }
  return cachedExpected;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function assertAuth(req: Request): AuthIdentity {
  const got = req.headers.get("authorization");
  const expected = expectedBearer();
  if (got === null) throw unauthorized();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
  return { user_id: "ui" };
}

/**
 * Cookie-auth variant for SSE routes the browser opens via `EventSource`.
 * Reads `UI_COOKIE_NAME` from the request `Cookie` header and timing-safe
 * compares it to `env.MASTER_KEY`. Throws a 401 Response on mismatch.
 *
 * Used by /api/ui/sessions/:id/stream — the browser can't attach an
 * Authorization header to an EventSource, so we accept the same secret
 * through an HttpOnly cookie installed at /login time.
 */
export function assertCookieAuth(req: Request): AuthIdentity {
  const cookieHeader = req.headers.get("cookie") || "";
  // Naive parse: cookies look like "k=v; k2=v2". HttpOnly cookies set by
  // our /auth/cookie endpoint don't contain `;` or `=` inside values, so
  // this is fine. We don't pull in a cookie-parser dep for one read.
  let got: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== UI_COOKIE_NAME) continue;
    got = part.slice(eq + 1).trim();
    break;
  }
  if (got === null) throw unauthorized();
  const a = Buffer.from(got);
  const b = Buffer.from(env.MASTER_KEY);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
  return { user_id: "ui" };
}

// ---------------------------------------------------------------------------
// Per-pod agent token auth — accepts either a valid agent access token
// scoped to this URL's agent_id + the route's required scope, or the
// MASTER_KEY (for UI/CLI parity). See src/server/auth/agent-token.ts.
// ---------------------------------------------------------------------------

export interface AssertAgentTokenOpts {
  /** Required scope claim on the access token (e.g. "memory"). */
  scope: AgentScope;
  /** The URL's agent_id param; the token's `agent_id` claim must match. */
  agent_id: string;
}

export interface AgentAuthIdentity {
  /** "agent" when the request came in with a scoped agent token, "ui" for master key. */
  source: "agent" | "ui";
  /** Present only for the "agent" path. */
  agent_id?: string;
}

/**
 * Variant of `assertAuth` for routes the harness reaches from inside a
 * sandbox pod. Accepts either:
 *   - a scoped agent access token whose claims match the URL/scope, or
 *   - the master key (so the UI keeps working for these routes too).
 *
 * On agent-token rejection we still try master-key — failing both yields
 * a single 401 with no leak about which path was being attempted.
 */
export function assertAgentTokenOrMaster(
  req: Request,
  opts: AssertAgentTokenOpts,
): AgentAuthIdentity {
  const header = req.headers.get("authorization");
  if (header === null) throw unauthorized();
  if (!header.startsWith("Bearer ")) throw unauthorized();
  const token = header.slice("Bearer ".length);

  // Path 1: scoped agent token.
  const verified = verifyAgentAccessToken(token, {
    expected_agent_id: opts.agent_id,
    required_scope: opts.scope,
  });
  if (verified.ok) {
    return { source: "agent", agent_id: verified.claims.agent_id };
  }

  // Path 2: master-key bearer. Constant-time compare against the cached
  // expected value so this branch matches the timing profile of assertAuth.
  const a = Buffer.from(header);
  const b = Buffer.from(expectedBearer());
  if (a.length === b.length && timingSafeEqual(a, b)) {
    return { source: "ui" };
  }

  throw unauthorized();
}
