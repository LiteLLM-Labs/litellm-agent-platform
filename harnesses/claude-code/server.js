// Minimal bridge: serves a static xterm.js page on /, accepts WebSocket
// upgrades on /tty, and pipes bytes between the browser terminal and a
// real PTY running the configured command (default: `claude`).
//
// Protocol on /tty:
//   browser -> server : raw text (keystrokes)  OR  JSON {"type":"resize","cols":N,"rows":M}
//   server  -> browser: raw bytes (PTY stdout)
//
// Override the command for testing without an API key:
//   POC_CMD=bash docker run …

import http from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const PORT = Number(process.env.PORT ?? 4096);
const CMD = process.env.POC_CMD ?? "claude";
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();

// Route Claude Code through the LiteLLM gateway when the platform passes
// LITELLM_API_BASE / LITELLM_API_KEY in. The `claude` CLI reads
// ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so rewrite at boot. Mirrors
// what harnesses/claude-agent-sdk/src/server.ts already does for the SDK.
if (process.env.LITELLM_API_BASE) {
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(
    /\/+$/,
    "",
  );
}
if (process.env.LITELLM_API_KEY) {
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.LITELLM_API_KEY;
  process.env.ANTHROPIC_API_KEY = process.env.LITELLM_API_KEY;
}

// Read the JSON body of an incoming request (server-side helper).
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cmd: CMD, repo: REPO_DIR }));
    return;
  }

  // Platform-compat stubs: the LAP platform expects every harness to expose
  // the same JSON contract (POST /session, GET /session/:id/message, etc.).
  // TUI harnesses don't actually use those — the session is the WS /tty
  // connection — but the platform's bootstrap calls POST /session before
  // marking the session ready. Return a constant id so it succeeds. The
  // other endpoints are stubs in case anything probes them.
  if (req.method === "POST" && req.url === "/session") {
    await readJson(req).catch(() => null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "tty" }));
    return;
  }
  if (/^\/session\/[^/]+\/message$/.test(req.url ?? "")) {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST") {
      await readJson(req).catch(() => null);
      // TUI mode: messages don't flow through the JSON API. Tell callers
      // to use the WS /tty endpoint instead.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "this is a TUI harness — connect to /tty" }));
      return;
    }
  }
  if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // SSE bus: keep open with periodic comments so the platform's stream-tail
  // doesn't immediately close.
  if (req.method === "GET" && req.url?.startsWith("/event")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const ka = setInterval(() => res.write(":keepalive\n\n"), 15000);
    req.on("close", () => clearInterval(ka));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server, path: "/tty" });

wss.on("connection", (ws) => {
  let term;
  try {
    term = pty.spawn(CMD, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: REPO_DIR,
      env: process.env,
    });
  } catch (e) {
    ws.send(`\r\n\x1b[31m[bridge] failed to spawn ${CMD}: ${e.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  console.log(`[bridge] spawned ${CMD} (pid ${term.pid}) for ${ws._socket.remoteAddress}`);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[2m[bridge] process exited (code=${exitCode}, signal=${signal ?? "-"})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { term.write(raw); return; }
    const s = raw.toString();
    // Resize messages are the only JSON we accept; everything else is
    // keystrokes. The startsWith check keeps the hot path cheap.
    if (s.length > 0 && s[0] === "{") {
      try {
        const msg = JSON.parse(s);
        if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          term.resize(msg.cols, msg.rows);
          return;
        }
      } catch { /* fall through and treat as keystrokes */ }
    }
    term.write(s);
  });

  ws.on("close", () => {
    try { term.kill(); } catch { /* already gone */ }
  });

  ws.on("error", (e) => console.warn(`[bridge] ws error: ${e.message}`));
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://0.0.0.0:${PORT}  (cmd=${CMD}, cwd=${REPO_DIR})`);
});
