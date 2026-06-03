// index.mjs — state wiring + HTTP router. Exports createState/createApp as a
// library; runs an HTTP server only when executed directly (node index.mjs).
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { HttpError, sendError } from "./core.mjs";
import { createSessionStore, createEventStore } from "./store.mjs";
import { createManagedSession } from "./runtime.mjs";
import * as routes from "./routes.mjs";

// ── state ────────────────────────────────────────────────────────────────────

/**
 * Build the shared context the router passes to every handler.
 * @param {{ serverPath: string, env: NodeJS.ProcessEnv }} options
 */
export function createState({ serverPath, env }) {
  const sessionStore = createSessionStore();
  const eventStore = createEventStore();
  const runtimes = new Map();

  function spawnManagedSession(sessionId, spawnArgs) {
    const rt = createManagedSession({
      sessionId,
      spawnArgs,
      serverPath,
      env,
      emit: (bareEvent) => {
        // Keep session status in sync with terminal events so GET /sessions/:id
        // never reports a stale "running".
        if (bareEvent.type === "session.status_idle") sessionStore.setStatus(sessionId, "idle");
        else if (bareEvent.type === "session.status_error") sessionStore.setStatus(sessionId, "error");
        eventStore.publish(sessionId, bareEvent);
      },
    });
    runtimes.set(sessionId, rt);
    return rt;
  }

  return {
    sessionStore,
    eventStore,
    spawnManagedSession,
    getRuntime: (id) => runtimes.get(id),
    deleteRuntime: (id) => runtimes.delete(id),
    serverPath,
    env,
  };
}

// ── router ───────────────────────────────────────────────────────────────────

// ORDER MATTERS — the stream route must precede the plain events route.
const ROUTES = [
  { method: "POST",   pattern: "/v1/sessions",                   handler: routes.createSession },
  { method: "GET",    pattern: "/v1/sessions/:id/events/stream", handler: routes.streamEvents },
  { method: "GET",    pattern: "/v1/sessions/:id/events",        handler: routes.listEvents },
  { method: "POST",   pattern: "/v1/sessions/:id/events",        handler: routes.sendEvent },
  { method: "GET",    pattern: "/v1/sessions/:id",               handler: routes.getSession },
  { method: "DELETE", pattern: "/v1/sessions/:id",               handler: routes.deleteSession },
];

const segments = (path) => path.split("/").filter(Boolean);

/** Match a path against a pattern with a single ":id" wildcard. */
function matchRoute(pattern, path) {
  const ps = segments(pattern);
  const qs = segments(path);
  if (ps.length !== qs.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = qs[i];
    else if (ps[i] !== qs[i]) return null;
  }
  return { params };
}

/** Read + JSON-parse a request body; attach to req.body. Returns false on bad JSON (already responded). */
function readBody(req, res) {
  return new Promise((resolve_) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        req.body = {};
        return resolve_(true);
      }
      try {
        req.body = JSON.parse(raw);
        resolve_(true);
      } catch {
        sendError(res, 400, "invalid JSON body");
        resolve_(false);
      }
    });
    req.on("error", () => {
      sendError(res, 400, "invalid JSON body");
      resolve_(false);
    });
  });
}

/** Create the http.Server (not yet listening). */
export function createApp(ctx) {
  return createServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    if (method === "POST") {
      const ok = await readBody(req, res);
      if (!ok) return;
    }

    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const match = matchRoute(route.pattern, urlPath);
      if (!match) continue;
      try {
        await route.handler(req, res, ctx, match.params);
      } catch (err) {
        if (err instanceof HttpError) sendError(res, err.status, err.message);
        else {
          console.error("[managed-agents] unhandled error:", err);
          sendError(res, 500, "internal error");
        }
      }
      return;
    }
    sendError(res, 404, "not found");
  });
}

// ── entry point (only when run directly) ─────────────────────────────────────

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(here, "../server.mjs"); // the lite-harness subprocess entry
  const ctx = createState({ serverPath, env: process.env });
  const port = Number(process.env.PORT) || 4096;
  createApp(ctx).listen(port, () =>
    console.log(`managed-agents server on http://localhost:${port}`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
