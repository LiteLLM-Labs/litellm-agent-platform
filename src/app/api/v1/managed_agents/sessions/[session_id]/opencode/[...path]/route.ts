/**
 * ALL /api/v1/managed_agents/sessions/[session_id]/opencode/[...path]
 *
 * The single backend surface for talking to a session's agent. LAP exposes
 * the pod's opencode server VERBATIM under this per-session base, so the
 * official `@opencode-ai/sdk` (which has opencode's paths hardcoded —
 * `/event`, `/session/:id/message`, …) can be pointed straight at it:
 *
 *   createOpencodeClient({ baseUrl: "…/sessions/:id/opencode" })
 *
 * This replaces the hand-rolled /stream, /message_stream, /events, /message,
 * and /messages routes. LAP keeps doing the only things opencode can't: auth
 * (master-key bearer) and resolving the session → its pod `sandbox_url`. The
 * pod is only reachable from inside the cluster, so the harness needs no
 * additional auth header here (matches the existing harness client).
 *
 * SSE (`GET …/opencode/event`) and JSON (message send / history) both stream
 * through untouched — opencode's wire format IS the contract. The browser can
 * not attach a bearer to its requests, so it goes through the cookie-authed
 * shim at /api/ui/sessions/:id/opencode/[...path], which forwards here.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { getCachedSession, type SessionCacheEntry } from "@/server/sessionCache";
import { markUserMessageFailed } from "@/server/sessionStore";
import {
  recordUserSend,
  watchEventStreamAndSnapshot,
} from "@/server/sessionThreadSync";
import { HttpError, httpError } from "@/server/types";

// opencode paths we persist from. The web UI / CLI drive the harness through
// this proxy (never our /message route), so the durable conversation log has to
// be captured here. See src/server/sessionThreadSync.ts.
const SEND_PATH = /^session\/[^/]+\/(message|prompt_async)$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; path?: string[] }>;
}

// The SDK can subscribe / send right after createSession, while the pod is
// still pulling images and starting the harness. Wait for `ready` before
// forwarding, matching the old /stream route's behavior.
const READY_WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;

/**
 * Resolve the session to its ready cache entry, polling until the pod comes
 * up. Fails fast on terminal states (404 missing, 410 failed/dead) and on the
 * 60s ceiling (504).
 */
async function resolveReady(
  session_id: string,
  signal: AbortSignal,
): Promise<SessionCacheEntry> {
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  for (;;) {
    const cached = await getCachedSession(session_id);
    if (cached) return cached;
    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { status: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);
    if (row.status === "failed" || row.status === "dead") {
      httpError(410, `session ${session_id} is ${row.status}`);
    }
    if (signal.aborted) httpError(503, "client disconnected");
    if (Date.now() >= deadline) {
      httpError(504, `session ${session_id} not ready within 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

async function proxy(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
    const { session_id, path } = await ctx.params;
    const tail = (path ?? []).join("/");
    const search = new URL(req.url).search;

    // Tie the upstream connection to the client's. EventSource / fetch-stream
    // closes on unload; Next forwards that as req.signal abort. Without this,
    // the pod-side SSE stays open until the harness keepalive ceiling.
    const upstreamCtl = new AbortController();
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });

    const cached = await resolveReady(session_id, req.signal);
    const target = `${cached.sandbox_url}/${tail}${search}`;

    const headers: Record<string, string> = {
      "content-type": req.headers.get("content-type") ?? "application/json",
      accept: req.headers.get("accept") ?? "*/*",
    };
    const init: RequestInit = {
      method: req.method,
      headers,
      signal: upstreamCtl.signal,
      cache: "no-store",
    };
    let bodyBuf: ArrayBuffer | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Buffer the body — opencode message payloads are small JSON (text +
      // optional base64 image parts), and buffering sidesteps undici's
      // half-duplex streaming-body constraints.
      bodyBuf = await req.arrayBuffer();
      init.body = bodyBuf;
    }

    // Persist the user turn before the prompt reaches the harness, so a sandbox
    // that dies mid-turn still leaves it recoverable + visible in the Session
    // Log. The UI never hits our /message route — this proxy is the only place
    // the send is observable. Awaited (one small insert) for durable-before-send.
    let sentUserMsgId: string | null = null;
    if (req.method === "POST" && SEND_PATH.test(tail) && bodyBuf) {
      sentUserMsgId = await recordUserSend({
        session_id,
        harness_session_id: cached.harness_session_id,
        body: bodyBuf,
      });
    }

    // For GET session/:id/message, catch both network failures (unreachable pod)
    // and 404 (pod restarted, session lost from memory) and fall back to the DB
    // history snapshot so the UI can still render the conversation.
    const isMessageHistory =
      req.method === "GET" && /^session\/[^/]+\/message$/.test(tail);

    let upstream: Response;
    if (isMessageHistory) {
      try {
        upstream = await fetch(target, init);
      } catch {
        upstream = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
    } else {
      try {
        upstream = await fetch(target, init);
      } catch (err) {
        // Harness unreachable — flag the just-recorded user turn `failed` so it
        // isn't replayed as a phantom unanswered turn on the next recovery.
        if (sentUserMsgId) await markUserMessageFailed(sentUserMsgId);
        throw err;
      }
    }

    // Non-2xx from the harness (rate limit, bad request, …): same cleanup. The
    // error status is still proxied back to the client below.
    if (sentUserMsgId && !upstream.ok) {
      await markUserMessageFailed(sentUserMsgId);
    }

    // When the harness doesn't know about this session (pod restarted, in-memory
    // state lost) it returns 404 for GET session/:id/message. Fall back to the
    // last-snapshotted history so the UI can still render the conversation.
    if (isMessageHistory && upstream.status === 404) {
      const row = await prisma.session.findUnique({
        where: { session_id },
        select: { history: true },
      });
      if (Array.isArray(row?.history) && (row.history as unknown[]).length > 0) {
        return Response.json(row.history);
      }
    }

    const ct = upstream.headers.get("content-type") ?? "application/json";
    const outHeaders: Record<string, string> = { "content-type": ct };
    if (ct.includes("text/event-stream")) {
      outHeaders["cache-control"] = "no-cache, no-transform";
      outHeaders["connection"] = "keep-alive";
      // Disable proxy buffering on any nginx/Render edge that respects it.
      outHeaders["x-accel-buffering"] = "no";
    }
    // Tee the `/event` bus so we can persist turns server-side: one branch
    // streams to the client untouched, the other is consumed to watch for
    // `session.idle` and snapshot the thread into the durable log + history.
    // This is the only completion signal — the client builds its view from the
    // bus and never re-fetches the thread.
    if (
      req.method === "GET" &&
      tail === "event" &&
      ct.includes("text/event-stream") &&
      upstream.body
    ) {
      const [clientStream, watchStream] = upstream.body.tee();
      void watchEventStreamAndSnapshot(watchStream, {
        session_id,
        sandbox_url: cached.sandbox_url,
        harness_session_id: cached.harness_session_id,
      });
      return new Response(clientStream, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error("opencode proxy error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
