#!/usr/bin/env node
/*
 * opencode inline adapter — makes attached skills LOADABLE on the single shared
 * `opencode serve` (the opencode-brain-inline harness).
 *
 * Why an adapter at all: opencode discovers skills from disk at session-create
 * time, and the platform delivers an agent's skills as SandboxFileSpec entries
 * in the POST /session `files` array. opencode *does* write that array, but only
 * after the session is created — too late for the new session to discover them.
 * So this adapter writes the skill files to the shared global skills dir
 * (~/.claude/skills) BEFORE forwarding session-create, so opencode picks them up
 * for that turn.
 *
 * Skills are written to the shared dir (not a per-agent directory): on this
 * shared server every agent sees every attached skill. We deliberately do NOT
 * pin sessions to a per-agent `?directory` — opencode's `/event` bus is
 * directory-scoped, and the UI's `/event` subscription has no directory, so a
 * per-session directory would hide the live transcript (the chat would hang on
 * "thinking…" even though the turn completed).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");
const DRAIN_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;

const log = (...a) => console.log("[inline-adapter]", ...a);

// Lifecycle state
let draining = false;       // true once SIGTERM received
let inFlight = 0;           // count of requests currently being handled
let restartCount = 0;       // how many times we've restarted the child
let currentChild = null;    // reference to the active child process

function checkDrainComplete() {
  if (draining && inFlight === 0) {
    log("drain complete — exiting");
    process.exit(0);
  }
}

// A SandboxFileSpec is a skill file when its sandbox_path lands in a skills dir
// and is a SKILL.md. Returns the slug (the directory under skills/), else null.
// Leading-alnum anchor rejects "." / ".." so a crafted name can't escape the dir.
function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9][a-z0-9._-]*$/i.test(m[1]) ? m[1] : null;
}

// Write a session's skill files to the shared global skills dir so opencode
// discovers them when it creates the session. Returns how many were written.
function materializeSkills(files) {
  let written = 0;
  for (const f of files || []) {
    const slug = skillSlug(f.sandbox_path);
    if (!slug) continue;
    const dir = path.join(SKILLS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), Buffer.from(f.content || "", "base64"));
    written++;
  }
  return written;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

function forward(method, urlPath, search, bodyBuf, clientRes) {
  const upReq = http.request(UP + urlPath + (search || ""), { method, headers: { "content-type": "application/json" } }, (upRes) => {
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
  });
  upReq.on("error", (e) => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: String(e) })); });
  if (bodyBuf) upReq.write(bodyBuf);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/" || p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true, draining }));
    return;
  }

  // Reject NEW session creates while draining; all other in-flight paths continue.
  if (draining && p === "/session" && req.method === "POST") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server is draining — no new sessions accepted" }));
    return;
  }

  inFlight++;
  let decremented = false;
  const decrement = () => { if (!decremented) { decremented = true; inFlight--; checkDrainComplete(); } };
  res.on("finish", decrement);
  res.on("close", decrement);

  // POST /session: materialize this agent's skills before opencode creates the
  // session, then forward unchanged (no ?directory — keep the /event bus global).
  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const n = materializeSkills(body.files);
    // Drop skill files from the forwarded body — opencode would otherwise
    // re-write them (to the same path) after create, which is just wasted work.
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s)`);
    forward("POST", "/session", "", Buffer.from(JSON.stringify(body)), res);
    return;
  }

  // Everything else (/event, /session/:id/*, ...) — transparent passthrough.
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, url.search, raw ? Buffer.from(raw) : null, res);
});

// Boot the shared opencode serve as a child, then start accepting traffic.
function spawnChild() {
  log(`spawning: opencode serve on :${CHILD_PORT} (restart #${restartCount})`);
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(CHILD_PORT)], {
    stdio: "inherit",
    env: process.env,
  });
  currentChild = child;

  child.on("exit", (code) => {
    currentChild = null;
    log(`opencode serve exited (${code})`);

    if (draining) {
      // During a graceful drain we do not restart — just let the drain complete.
      log("draining — not restarting child");
      checkDrainComplete();
      return;
    }

    restartCount++;
    if (restartCount > MAX_RESTARTS) {
      log(`child exited ${restartCount} times — giving up`);
      process.exit(code ?? 1);
    }

    const delay = Math.pow(2, restartCount - 1) * 1000; // 1s, 2s, 4s
    log(`restarting child in ${delay}ms (attempt ${restartCount}/${MAX_RESTARTS})`);
    setTimeout(spawnChild, delay);
  });
}

async function waitChild() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      // Ready = the child answers HTTP at all. opencode is installed unpinned, and
      // its `/` route's status code has drifted across versions (200 -> 404/redirect);
      // requiring exactly 200 here silently wedged the deploy ("No open ports on
      // 0.0.0.0") because the adapter never reached server.listen(). Any HTTP
      // response means opencode is up and serving, which is all we need.
      const rq = http.get(UP + "/", (res) => { res.resume(); r((res.statusCode ?? 0) > 0); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

process.on("SIGTERM", () => {
  log("SIGTERM received — draining (no new sessions; existing sessions allowed to finish)");
  draining = true;

  // Stop accepting new connections.
  server.close();

  // Hard exit once the drain timeout elapses regardless of in-flight count.
  setTimeout(() => {
    log(`drain timeout (${DRAIN_TIMEOUT_MS}ms) reached — forcing exit`);
    process.exit(0);
  }, DRAIN_TIMEOUT_MS).unref();

  // If nothing is in-flight right now, exit immediately.
  checkDrainComplete();
});

fs.mkdirSync(SKILLS_ROOT, { recursive: true });
spawnChild();
waitChild().then((ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  server.listen(PORT, "0.0.0.0", () => log(`listening :${PORT} -> ${UP} | skills=${SKILLS_ROOT}`));
});
