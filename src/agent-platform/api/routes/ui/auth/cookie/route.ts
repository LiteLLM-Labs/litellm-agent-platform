/**
 * POST /api/ui/auth/cookie
 *
 * Installs the HttpOnly cookie that gates `/api/ui/*` SSE proxy routes.
 *
 * The browser can't attach an `Authorization` header to `EventSource`, so
 * cookie-auth is required for any UI-opened SSE subscription. This endpoint
 * accepts the bearer master key the way every other UI route does
 * (`Authorization: Bearer <MASTER_KEY>`) and, on success, sets a
 * matching HttpOnly cookie that the `/api/ui/sessions/:id/stream` route
 * reads via `assertCookieAuth`.
 *
 * Called by the session detail page once on mount (idempotent) right
 * before opening `new EventSource("/api/ui/sessions/:id/stream")`.
 */

import { assertAuth, UI_COOKIE_NAME } from "@/api/auth";
import { env } from "@/api/env";
import { HttpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertAuth(req);
    // 24h ttl matches a typical UI session — the user re-pastes the master
    // key into /login when this expires.
    const maxAgeSeconds = 24 * 60 * 60;
    // Set Secure only when the request actually arrived over HTTPS (i.e. the
    // LB set X-Forwarded-Proto: https). Hardcoding to NODE_ENV=production
    // breaks HTTP-only deployments — the browser silently drops Secure cookies
    // on HTTP, so assertCookieAuth never sees the cookie.
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const secure = proto === "https" ? "; Secure" : "";
    const cookie =
      `${UI_COOKIE_NAME}=${encodeURIComponent(env.MASTER_KEY)}` +
      `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": cookie },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * DELETE /api/ui/auth/cookie — clears the HttpOnly cookie. Called by the
 * /login page on its mount (mirrors `clearStoredMasterKey()`).
 */
export async function DELETE(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const secure = proto === "https" ? "; Secure" : "";
  const cookie =
    `${UI_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": cookie },
  });
}
