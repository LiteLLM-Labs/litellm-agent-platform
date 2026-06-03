// routes.mjs — the six V0 request handlers. Each is (req, res, ctx, params).
// HttpErrors thrown here are caught by the router in index.mjs.
import { HttpError, sendJson, userMessageEvent, sessionErrorEvent } from "./core.mjs";
import { resolveHarness } from "./runtime.mjs";

/** POST /v1/sessions — body { agent, model? } */
export async function createSession(req, res, ctx) {
  const { agent, model } = req.body ?? {};
  if (!agent) throw new HttpError(400, "agent is required");
  const { agent: a, spawnArgs } = resolveHarness(agent, model);
  const session = ctx.sessionStore.create({ agent: a });
  ctx.spawnManagedSession(session.id, spawnArgs).start();
  sendJson(res, 201, session);
}

/** GET /v1/sessions/:id */
export async function getSession(req, res, ctx, params) {
  const s = ctx.sessionStore.get(params.id);
  if (!s) throw new HttpError(404, "session not found");
  sendJson(res, 200, s);
}

/** DELETE /v1/sessions/:id */
export async function deleteSession(req, res, ctx, params) {
  if (!ctx.sessionStore.get(params.id)) throw new HttpError(404, "session not found");
  ctx.getRuntime(params.id)?.kill();
  ctx.deleteRuntime(params.id);
  ctx.eventStore.deleteSession(params.id);
  ctx.sessionStore.delete(params.id);
  sendJson(res, 200, { id: params.id, object: "session", deleted: true });
}

/** POST /v1/sessions/:id/events — fire-and-forget user turns */
export async function sendEvent(req, res, ctx, params) {
  if (!ctx.sessionStore.get(params.id)) throw new HttpError(404, "session not found");

  const runtime = ctx.getRuntime(params.id);
  // A dead/absent runtime can't deliver the turn — surface it instead of
  // returning a misleading { ok: true } with an undelivered user.message.
  if (!runtime || !runtime.isAlive()) {
    throw new HttpError(409, "session runtime is not available");
  }

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const ev of events) {
    if (ev.type !== "user.message") continue;
    ctx.eventStore.publish(params.id, userMessageEvent(ev.content));
    ctx.sessionStore.setStatus(params.id, "running");
    // Fire-and-forget: output streams back via SSE / history. A delivery
    // failure is reported as a session.status_error event (which also flips
    // status to "error" via the createState emit wiring).
    runtime.sendUserMessage(ev.content).catch((err) => {
      ctx.sessionStore.setStatus(params.id, "error");
      ctx.eventStore.publish(params.id, sessionErrorEvent(`failed to deliver message: ${err.message}`));
    });
  }
  sendJson(res, 200, { ok: true });
}

/** GET /v1/sessions/:id/events */
export async function listEvents(req, res, ctx, params) {
  if (!ctx.sessionStore.get(params.id)) throw new HttpError(404, "session not found");
  sendJson(res, 200, { object: "list", data: ctx.eventStore.list(params.id) });
}

/** GET /v1/sessions/:id/events/stream — replay history, then live SSE */
export async function streamEvents(req, res, ctx, params) {
  if (!ctx.sessionStore.get(params.id)) throw new HttpError(404, "session not found");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const ev of ctx.eventStore.list(params.id)) write(ev);
  const unsub = ctx.eventStore.subscribe(params.id, write);
  req.on("close", () => {
    unsub();
    try { res.end(); } catch { /* already closed */ }
  });
  // keep the stream open
}
