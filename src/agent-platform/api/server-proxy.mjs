#!/usr/bin/env node
// server-proxy.mjs
//
// TCP-level reverse proxy that runs in front of the Next.js standalone
// server. It intercepts WebSocket upgrade requests bound for
//   /api/v1/managed_agents/sessions/<id>/tty
// and pipes the raw TCP connection directly to the cluster-internal sandbox
// pod (sandbox_url from the DB). Every other connection is forwarded to the
// Next.js server running on NEXT_PORT (default 3001).
//
// Why TCP-level: Next.js 16 App Router route handlers don't support WS
// upgrades (the connection closes after the response is generated). A
// raw-TCP proxy operates below the HTTP layer and avoids that restriction.
//
// Auth: the incoming WS upgrade must carry ?token=<value> matching
// HARNESS_AUTH_TOKEN. The token is forwarded as-is to the sandbox, which
// performs its own constant-time check.
//
// Startup: CMD ["sh", "-c", "... && node src/api/server-proxy.mjs"]
// Next.js is spawned as a child process on NEXT_PORT.

import { connect } from "net";
import { createServer as createHttpServer, request as httpRequest } from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import { timingSafeEqual, createHash } from "crypto";
import { URL } from "url";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

const require = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const NEXT_PORT = parseInt(process.env.NEXT_PORT ?? "3001", 10);
// Use BIND_HOST, not HOSTNAME: Kubernetes injects HOSTNAME as the pod name,
// which causes proxy.listen to bind on a single pod IP instead of all
// interfaces (and may fail DNS lookup at startup).
const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";

// Token accepted on the incoming WS upgrade: the harness auth token only.
// MASTER_KEY is intentionally excluded — it would appear in plaintext in
// ALB access logs and browser history if used as a URL query parameter.
const HARNESS_TOKEN = (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
const CONTAINER_HARNESS_TOKEN = (process.env.CONTAINER_ENV_HARNESS_AUTH_TOKEN ?? "").trim();
if (!HARNESS_TOKEN && !CONTAINER_HARNESS_TOKEN) {
  console.warn("[tty-proxy] WARNING: neither HARNESS_AUTH_TOKEN nor CONTAINER_ENV_HARNESS_AUTH_TOKEN is set — all TTY WebSocket connections will be rejected");
}

function tokenOk(presented) {
  if (!presented) return false;
  const check = (expected) => {
    if (!expected) return false;
    try {
      const a = Buffer.from(presented, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  };
  return check(HARNESS_TOKEN) || check(CONTAINER_HARNESS_TOKEN);
}

// --- Prisma lazy singleton ---
let _prisma = null;
function getPrisma() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient({ log: [] });
  }
  return _prisma;
}

// --- Fix 1: DB cache (session_id → sandbox_url, 30s TTL) ---
const SESSION_CACHE_TTL = 30_000;
/** @type {Map<string, {url: string|null, expiresAt: number}>} */
const sessionUrlCache = new Map();

async function getSandboxUrl(sessionId) {
  const now = Date.now();
  const cached = sessionUrlCache.get(sessionId);

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  try {
    const session = await getPrisma().session.findUnique({
      where: { session_id: sessionId },
      select: { sandbox_url: true, status: true },
    });
    const url = session?.sandbox_url ?? null;
    // Only cache non-null URLs. A null sandbox_url means the sandbox is still
    // spinning up; caching null would return 503 for 30s even after it's ready.
    if (url !== null) {
      sessionUrlCache.set(sessionId, { url, expiresAt: now + SESSION_CACHE_TTL });
    }
    return url;
  } catch (e) {
    if (cached) {
      console.warn("[tty-proxy] DB lookup failed, using stale cache for session", sessionId, e.message);
      return cached.url;
    }
    throw e;
  }
}

const TTY_PATH_RE = /\/api\/v1\/managed_agents\/sessions\/([^/?]+)\/tty/;

let draining = false;

// Proxy a regular HTTP request to Next.js on NEXT_PORT.
function forwardHttpToNext(req, res) {
  if (draining) { res.writeHead(503); res.end(); return; }
  const proxy = httpRequest({
    hostname: "127.0.0.1",
    port: NEXT_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
  req.pipe(proxy, { end: true });
}

async function handleTtyUpgrade(clientSocket, buf, sessionId, token) {
  console.log(`[tty-proxy] request session=${sessionId} token_present=${!!token}`);

  if (!tokenOk(token)) {
    console.warn(`[tty-proxy] 401 session=${sessionId} presented=${token ? token.slice(0,8) + "…" : "(empty)"} HARNESS_TOKEN_SET=${!!HARNESS_TOKEN} CONTAINER_TOKEN_SET=${!!CONTAINER_HARNESS_TOKEN}`);
    try {
      clientSocket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let sandboxUrl;
  try {
    sandboxUrl = await getSandboxUrl(sessionId);
  } catch (e) {
    console.error(`[tty-proxy] 503 session=${sessionId} reason=db_error error=${e.message}`);
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  if (!sandboxUrl) {
    console.warn(`[tty-proxy] 503 session=${sessionId} reason=no_sandbox_url (session not ready or missing)`);
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let parsed;
  try {
    parsed = new URL(sandboxUrl);
  } catch {
    console.error(`[tty-proxy] 500 session=${sessionId} reason=bad_sandbox_url sandbox_url=${sandboxUrl}`);
    try { clientSocket.destroy(); } catch {}
    return;
  }

  const host = parsed.hostname;
  const port = parseInt(parsed.port || "80", 10);

  // Rewrite the request line before forwarding to the sandbox.
  // The browser sends: GET /api/v1/managed_agents/sessions/{id}/tty?token=X HTTP/1.1
  // The harness only handles:            GET /tty?token=X HTTP/1.1
  const rawStr = buf.toString("latin1");
  const lineEnd = rawStr.indexOf("\r\n");
  const parts = rawStr.slice(0, lineEnd).split(" ");
  const origPath = parts[1] ?? "/tty";
  const qIdx = origPath.indexOf("?");
  const ttyPath = "/tty" + (qIdx >= 0 ? origPath.slice(qIdx) : "");
  // Default the HTTP version to avoid "undefined" in the forwarded line if the
  // request line is somehow malformed with fewer than 3 space-delimited tokens.
  const httpVersion = parts[2] ?? "HTTP/1.1";
  const forwardBuf = Buffer.from(
    `${parts[0]} ${ttyPath} ${httpVersion}` + rawStr.slice(lineEnd),
    "latin1",
  );

  console.log(`[tty-proxy] connecting session=${sessionId} target=${host}:${port}`);

  const target = connect(port, host);
  target.once("connect", () => {
    // Peek at the harness response to catch non-101 rejections before piping.
    let peeked = false;
    const onFirstData = (chunk) => {
      if (peeked) return;
      peeked = true;
      const firstLine = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (firstLine.includes("101")) {
        console.log(`[tty-proxy] upgraded session=${sessionId} target=${host}:${port} response="${firstLine}"`);
      } else {
        console.warn(`[tty-proxy] upgrade_rejected session=${sessionId} target=${host}:${port} response="${firstLine}"`);
      }
    };
    target.once("data", onFirstData);

    target.write(forwardBuf);
    clientSocket.pipe(target);
    target.pipe(clientSocket);
    clientSocket.on("error", (e) => {
      console.error(`[tty-proxy] client socket error session=${sessionId}:`, e.message);
      try { target.destroy(); } catch {}
    });
    target.on("error", (e) => {
      console.error(`[tty-proxy] sandbox socket error session=${sessionId} target=${host}:${port}:`, e.message);
      try { clientSocket.destroy(); } catch {}
    });
  });
  target.once("error", (e) => {
    console.error(`[tty-proxy] sandbox connect error session=${sessionId} target=${host}:${port}: ${e.message}`);
    try { clientSocket.destroy(); } catch {}
  });
}

function extractToken(req) {
  const auth = (req.headers["authorization"] ?? "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const q = (req.url ?? "").indexOf("?");
  if (q < 0) return "";
  return new URLSearchParams((req.url ?? "").slice(q + 1)).get("token") ?? "";
}

function createProxy() {
  // Use http.createServer so each HTTP request on a keep-alive connection is
  // handled independently. The old net.createServer approach piped the entire
  // TCP connection to Next.js after the first request, causing ALB-reused
  // connections to bypass the /tty intercept for subsequent requests.
  const server = createHttpServer((req, res) => {
    const url = req.url ?? "";
    const match = url.match(TTY_PATH_RE);
    console.log(`[tty-proxy] ${req.method} ${url.slice(0,80)} tty=${!!match} upgrade=${req.headers["upgrade"]??""}`);

    if (match) {
      const sessionId = match[1];
      const token = extractToken(req);
      if (!tokenOk(token)) {
        console.warn(`[tty-proxy] 401 session=${sessionId} presented=${token ? token.slice(0,8)+"…" : "(empty)"} HARNESS_TOKEN_SET=${!!HARNESS_TOKEN} CONTAINER_TOKEN_SET=${!!CONTAINER_HARNESS_TOKEN}`);
        res.writeHead(401, { "content-length": "0", "connection": "close" });
        res.end();
        return;
      }
      // Proxy the WS upgrade to the harness using http.request so we don't
      // need to detach the socket from http.createServer. Node's http.request
      // 'upgrade' event fires when the upstream responds with 101, at which
      // point we take over both sockets and pipe WS frames bidirectionally.
      const qIdx = url.indexOf("?");
      const ttyPath = "/tty" + (qIdx >= 0 ? url.slice(qIdx) : "");
      getSandboxUrl(sessionId).then((sandboxUrl) => {
        if (!sandboxUrl) {
          res.writeHead(503, { "content-length": "0" }); res.end(); return;
        }
        let parsed;
        try { parsed = new URL(sandboxUrl); } catch {
          res.writeHead(502, { "content-length": "0" }); res.end(); return;
        }
        const hHost = parsed.hostname;
        const hPort = parseInt(parsed.port || "80", 10);
        console.log(`[tty-proxy] proxying tty session=${sessionId} → ${hHost}:${hPort}${ttyPath}`);
        // Use the client's real WS key so Sec-WebSocket-Accept verifies correctly.
        // ALB may have stripped Sec-WebSocket-Key; fall back to a default and
        // recompute the accept value ourselves so the client can verify it.
        const clientKey = req.headers["sec-websocket-key"] ?? "dGhlIHNhbXBsZSBub25jZQ==";
        const proxyReq = httpRequest({
          hostname: hHost, port: hPort, path: ttyPath, method: "GET",
          headers: {
            host: `${hHost}:${hPort}`,
            upgrade: "websocket", connection: "upgrade",
            "sec-websocket-key": clientKey,
            "sec-websocket-version": req.headers["sec-websocket-version"] ?? "13",
          },
        });
        proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
          console.log(`[tty-proxy] 101 session=${sessionId}`);
          const clientSocket = req.socket;
          // Remove error handler BEFORE taking the socket so it can't write 502
          // to a socket that's mid-WS-handshake.
          proxyReq.removeAllListeners("error");
          clientSocket.removeAllListeners();
          // Build 101 response: compute Sec-WebSocket-Accept from the client's
          // actual key so the ws library can verify it even if ALB mangled it.
          const accept = wsAccept(clientKey);
          const header = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
          ].join("\r\n") + "\r\n\r\n";
          clientSocket.write(header);
          if (proxyHead?.length > 0) clientSocket.write(proxyHead);
          proxySocket.pipe(clientSocket);
          clientSocket.pipe(proxySocket);
          proxySocket.on("error", () => { try { clientSocket.destroy(); } catch {} });
          clientSocket.on("error", () => { try { proxySocket.destroy(); } catch {} });
        });
        proxyReq.on("response", (proxyRes) => {
          console.warn(`[tty-proxy] harness non-101 session=${sessionId} status=${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on("error", (e) => {
          console.error(`[tty-proxy] harness connect error session=${sessionId}:`, e.message);
          try { res.writeHead(502, { "content-length": "0" }); res.end(); } catch {}
        });
        proxyReq.end();
      }).catch((e) => {
        console.error(`[tty-proxy] getSandboxUrl error session=${sessionId}:`, e.message);
        try { res.writeHead(503, { "content-length": "0" }); res.end(); } catch {}
      });
      return;
    }

    if (draining) { res.writeHead(503); res.end(); return; }
    forwardHttpToNext(req, res);
  });

  // Also handle explicit WS upgrade events (when ALB preserves the header).
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const match = url.match(TTY_PATH_RE);
    if (!match) { socket.destroy(); return; }
    const sessionId = match[1];
    const token = extractToken(req);
    if (!tokenOk(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy(); return;
    }
    const qIdx = url.indexOf("?");
    const ttyPath = "/tty" + (qIdx >= 0 ? url.slice(qIdx) : "");
    let rawHeaders = `GET ${ttyPath} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) rawHeaders += `${k}: ${v}\r\n`;
    rawHeaders += "\r\n";
    const forwardBuf = head.length > 0
      ? Buffer.concat([Buffer.from(rawHeaders, "latin1"), head])
      : Buffer.from(rawHeaders, "latin1");
    socket.removeAllListeners();
    handleTtyUpgrade(socket, forwardBuf, sessionId, token).catch((e) => {
      console.error("[tty-proxy] upgrade error:", e.message);
      try { socket.destroy(); } catch {}
    });
  });

  return server;
}

// Start Next.js on an internal port so only the proxy faces the network.
// Returns the child process so the SIGTERM handler can kill it.
function startNextServer() {
  const child = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(NEXT_PORT), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`[tty-proxy] Next.js exited (code=${code ?? "?"})`);
    process.exit(code ?? 1);
  });
  process.on("exit", () => {
    try { child.kill(); } catch {}
  });
  return child;
}

// Fix 2: poll for Next.js TCP readiness before starting proxy
function waitForNextReady(port, intervalMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error(`Next.js did not become ready within ${timeoutMs}ms`));
          return;
        }
        console.debug(`[tty-proxy] waiting for Next.js on port ${port}...`);
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

const nextChild = startNextServer();

waitForNextReady(NEXT_PORT, 200, 60_000)
  .then(() => {
    console.log(`[tty-proxy] Next.js ready on 127.0.0.1:${NEXT_PORT}`);

    const proxy = createProxy();

    // Graceful drain on SIGTERM
    process.on("SIGTERM", () => {
      draining = true;
      proxy.close(() => {
        try { nextChild.kill(); } catch {}
        process.exit(0);
      });
      setTimeout(() => {
        try { nextChild.kill(); } catch {}
        process.exit(0);
      }, 30_000);
    });

    proxy.listen(PORT, BIND_HOST, () => {
      console.log(
        `[tty-proxy] listening on ${BIND_HOST}:${PORT} — Next.js on 127.0.0.1:${NEXT_PORT}`,
      );
    });
    proxy.on("error", (e) => {
      console.error("[tty-proxy] server error:", e.message);
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error("[tty-proxy]", e.message);
    process.exit(1);
  });
