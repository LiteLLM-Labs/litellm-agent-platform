/**
 * GET /api/v1/managed_agents/sessions/[session_id]/stream
 *
 * Pure passthrough SSE subscription to a session's harness event bus.
 *
 * Unlike /events (PR #46), which 409s when the session is still `creating`,
 * this route waits up to 60s for the pod to come up before opening upstream.
 * Designed for the SDK's "subscribe right after createSession" flow where
 * the consumer (e.g. shin for Slack) wants to start tailing progress
 * immediately and shouldn't have to poll for readiness on its own.
 *
 * Unlike /message_stream and /events, which wrap each upstream bus event as
 * `{ type: "harness_event", event: <evt> }`, this route forwards the raw
 * harness event JSON unchanged. The harness's events already have a `type`
 * field at the top level (e.g. `message.part.updated`, `session.idle`), so
 * consumers get exactly what the harness emitted.
 *
 * Wire shape per SSE event:
 *   data: { type: "stream.opened" }              // first frame, sent before any upstream events
 *   data: <raw harness bus event>                // forwarded verbatim, filtered to this session
 *
 * Filtering: opencode's /event bus emits global events; we only forward those
 * whose `properties.sessionID` matches this row's harness_session_id. A small
 * whitelist of global lifecycle events (server.connected, server.heartbeat)
 * also passes through so the client can detect liveness.
 *
 * Status responses:
 *   200  + SSE                              normal stream open
 *   404                                     session row missing
 *   410                                     session.status is failed or dead
 *   504                                     session didn't reach `ready` within 60s
 *
 * Connection lifecycle:
 *   1. Auth, look up session row.
 *   2. If status is failed/dead -> 410. Else poll prisma + readPodPhase until
 *      status="ready" AND sandbox_url is set, up to 60s. Else 504.
 *   3. Open SSE upstream to ${sandbox_url}/event.
 *   4. Emit `{type:"stream.opened"}`.
 *   5. Forward filtered events as-is until we observe session.idle for this
 *      id OR the client disconnects OR the 30-min hard ceiling fires.
 *   6. Cancel the upstream stream on teardown.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { harnessOpenEventStream } from "@/server/harness";
import { readPodPhase } from "@/server/k8s";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// Hard upper bound on a single stream connection. Long-running autonomous
// agents (Slack `@shin do X`) routinely run for many minutes; we cap at
// 30 min so a stuck session.idle doesn't pin the route forever.
const STREAM_MAX_DURATION_MS = 1_800_000;

// How long to wait for the session to reach `ready` before giving up. The
// SDK can call this route immediately after createSession and the pod may
// still be pulling images, cloning the repo, and starting the harness.
const READY_WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;

interface BusEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown> & { sessionID?: string };
}

function encodeSse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

interface ReadySession {
  sandbox_url: string;
  harness_session_id: string;
}

/**
 * Poll the session row until status="ready" and sandbox_url is populated,
 * or until the timeout fires. Returns null on timeout. Throws via httpError
 * if the session transitions to failed/dead while we wait.
 *
 * We also poke readPodPhase opportunistically so a Pending pod that flips
 * to Failed is surfaced via the next prisma read (the reconciler writes
 * the failed status). It's a best-effort signal — readPodPhase failures
 * are swallowed so a flaky apiserver doesn't kill an otherwise-fine wait.
 */
async function waitForSessionReady(
  session_id: string,
  abort: AbortSignal,
): Promise<ReadySession | null> {
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (abort.aborted) return null;
    const row = await prisma.session.findUnique({ where: { session_id } });
    if (!row) {
      httpError(404, `session ${session_id} not found`);
    }
    if (row.status === "failed" || row.status === "dead") {
      httpError(410, `session ${session_id} is ${row.status}`);
    }
    if (row.status === "ready" && row.sandbox_url && row.harness_session_id) {
      return {
        sandbox_url: row.sandbox_url,
        harness_session_id: row.harness_session_id,
      };
    }
    if (row.task_arn) {
      // Best-effort: surfaces a Pending-but-doomed pod earlier than the
      // reconciler would. We only inspect, never mutate — the reconciler
      // owns transitioning to failed/dead.
      await readPodPhase(row.task_arn).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return null;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    // Fast-path checks before we commit to a 60s wait: 404 / 410 surface
    // immediately so SDK consumers don't sit idle on a doomed session.
    const initial = await prisma.session.findUnique({
      where: { session_id },
    });
    if (!initial) {
      httpError(404, `session ${session_id} not found`);
    }
    if (initial.status === "failed" || initial.status === "dead") {
      httpError(410, `session ${session_id} is ${initial.status}`);
    }

    const ready = await waitForSessionReady(session_id, req.signal);
    if (!ready) {
      httpError(504, `session ${session_id} not ready within 60s`);
    }

    const { sandbox_url, harness_session_id } = ready;

    const upstreamCtl = new AbortController();
    // Tear down the upstream subscription if the client hangs up before
    // session.idle. Without this the SSE connection stays open until the
    // sandbox itself dies.
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });
    // Belt-and-suspenders deadline. If session.idle never arrives and the
    // client doesn't disconnect, this fires and aborts the upstream
    // subscription. The read loop then sees the abort and closes cleanly.
    const deadlineTimer = setTimeout(() => {
      upstreamCtl.abort();
    }, STREAM_MAX_DURATION_MS);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          try {
            controller.enqueue(encodeSse(payload));
          } catch {
            // Controller already closed (client gone). Swallow.
          }
        };
        const done = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        let upstream: Response;
        try {
          upstream = await harnessOpenEventStream({
            sandbox_url,
            signal: upstreamCtl.signal,
          });
        } catch (err) {
          console.error("harness event stream open failed", err);
          // No raw harness frame to forward here — but we still need to
          // signal the consumer the stream is dead. The SDK can detect
          // unexpected close + zero events. Just close.
          done();
          return;
        }

        // Tell the client the upstream is live. Sent BEFORE any harness
        // events so consumers have a deterministic "I'm connected" signal.
        send({ type: "stream.opened" });

        // Parse the upstream SSE stream line-by-line. opencode emits one
        // JSON object per `data:` line followed by a blank line — we buffer
        // partial lines in `pending` to handle TCP-level fragmentation.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";

        // Whitelist of bus event types that have no `sessionID` in their
        // properties but are still relevant to the client (lifecycle/error
        // signals from the instance bus). Everything else without a sessionID
        // is dropped — opencode emits global chatter (mDNS, server.*, etc.)
        // we don't want to leak across sessions.
        const SESSIONLESS_PASSTHROUGH = new Set([
          "server.connected",
          "server.heartbeat",
        ]);
        const handleBusEvent = (evt: BusEvent) => {
          const sid = evt.properties?.sessionID;
          if (!sid) {
            // No sessionID — only forward known-safe global lifecycle events.
            if (!SESSIONLESS_PASSTHROUGH.has(evt.type)) return false;
            send(evt);
            return false;
          }
          if (sid !== harness_session_id) return false;
          // Pure passthrough: forward the harness event verbatim. No
          // wrapping, no type renaming. Consumers want what the harness
          // sends. The harness's events already have a `type` at the top
          // level.
          send(evt);
          // session.idle for this session means the agent loop returned
          // control. Close the stream cleanly.
          if (evt.type === "session.idle") return true;
          return false;
        };

        try {
          let finished = false;
          while (!finished) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;
            pending += decoder.decode(value, { stream: true });
            // SSE frames are terminated by a blank line ("\n\n").
            for (;;) {
              const idx = pending.indexOf("\n\n");
              if (idx < 0) break;
              const frame = pending.slice(0, idx);
              pending = pending.slice(idx + 2);
              for (const line of frame.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                const raw = line.slice(5).trimStart();
                if (!raw) continue;
                let parsed: BusEvent;
                try {
                  parsed = JSON.parse(raw) as BusEvent;
                } catch {
                  continue;
                }
                if (handleBusEvent(parsed)) {
                  finished = true;
                  break;
                }
              }
              if (finished) break;
            }
          }
        } catch (err) {
          // Reader rejection during shutdown is expected when the client
          // aborts or the max-duration deadline fires; only log when we
          // weren't already tearing down.
          const errCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "unknown";
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!upstreamCtl.signal.aborted) {
            console.error(
              `[stream] upstream SSE dropped unexpectedly` +
              ` session=${session_id} code=${errCode} msg=${errMsg}` +
              ` clientAborted=${req.signal.aborted}`,
              err,
            );
          }
        } finally {
          clearTimeout(deadlineTimer);
          // Release the body reader's lock before aborting the controller
          // so undici tears the upstream socket down cleanly. Without this
          // the ReadableStream stays locked on every normal session.idle
          // exit and the connection sits open until GC.
          try {
            await reader.cancel();
          } catch {
            /* already cancelled or upstream errored */
          }
          upstreamCtl.abort();
          done();
        }
      },
      cancel() {
        clearTimeout(deadlineTimer);
        upstreamCtl.abort();
      },
    });

    // Best-effort housekeeping — mirrors /events and /message_stream.
    // Fire-and-forget so the cross-region DB round-trip doesn't sit on
    // TTFB for the SSE response.
    void prisma.session
      .update({
        where: { session_id },
        data: { last_seen_at: new Date() },
      })
      .catch((err) => {
        console.warn(
          `failed to bump last_seen_at for session ${session_id}:`,
          err,
        );
      });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Match opencode's own SSE response — disables proxy buffering on
        // any nginx/Render edge that respects the hint.
        "x-accel-buffering": "no",
      },
    });
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
