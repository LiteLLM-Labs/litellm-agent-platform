#!/usr/bin/env node
/**
 * sandbox-mcp — MCP server exposing sandbox tools to opencode.
 *
 * Two modes:
 *   1. Platform delegation: SESSION_ID + LAP_BASE_URL set in env → calls the
 *      platform's /api/v1/managed_agents/sessions/<id>/sandbox/* routes.
 *   2. Direct E2B: SESSION_ID env unset (the inline-shared harness serves many
 *      sessions from one process) → talks to E2B directly.
 *
 * Direct mode used to keep an in-process `Map<name, Sandbox>` keyed only by
 * the agent-supplied `name` ("main"). That collided across concurrent sessions
 * — Session B's provision("main") killed Session A's sandbox and overwrote
 * the map entry, so A's next execute() ran on B's box (branches B checked out,
 * processes B started, etc.). It also lost everyone's sandbox on a harness
 * restart because the Map was process-local.
 *
 * This file now scopes every direct-mode sandbox by session_id and persists
 * the e2b sandbox id on the session row via the /sandbox-id endpoint, so the
 * session is the unit of ownership and the harness can reconnect to a live
 * sandbox by id after restart. The in-process `sessionSandboxes` Map is just
 * a cache; the session row is the source of truth.
 */

import { Sandbox } from "e2b";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.LAP_BASE_URL;
const ENV_SESSION_ID = process.env.SESSION_ID;
const TOKEN = process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE || "base";
const VAULT_URL = process.env.VAULT_URL;
const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
// E2B auto-shuts a sandbox this long after its shutdown timer was last set. We
// reset that timer on every execute/read (keepalive, see below), so in practice
// this is "max idle before reaping", not a hard cap on total task time. 30 min
// tolerates long thinking gaps between tool calls without leaving zombies.
const SANDBOX_TIMEOUT_MS = 1_800_000;
// Per-command cap. A single step like a UI screenshot (cold chromium launch +
// lazy-compiled route + login + render) can run past 2 min; 120s silently
// terminated those mid-flight. 3 min gives that flow margin without leaving a
// genuinely hung command running much longer.
const EXECUTE_TIMEOUT_MS = 180_000;

const USE_DIRECT = !ENV_SESSION_ID;
// Cache only — source of truth is the session row's `sandbox_id` column. On
// cache miss we GET /sandbox-id and `Sandbox.connect` by id; if e2b says the
// sandbox is gone we DELETE /sandbox-id and the next provision creates fresh.
const sessionSandboxes = new Map(); // session_id → Sandbox

console.error(`[sandbox-mcp] mode=${USE_DIRECT ? "direct-e2b" : "platform"} template=${E2B_TEMPLATE} vault=${VAULT_URL ? "set" : "none"}`);

const server = new Server({ name: "opencode-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });

// `session_id` is required on every direct-mode tool call because the inline
// harness is a single shared process — there is no per-call session context
// other than what the agent passes. Documented per-tool below; the runtime
// enforces it in `resolveSessionId`.
const SESSION_ID_PROP = {
  type: "string",
  description: "LAP session ID. REQUIRED in the inline-shared harness (where SESSION_ID env is unset). When you have a <lap_session_id> block in context, pass that value.",
};

const TOOLS = [
  {
    name: "provision",
    description: "Provision a sandbox for THIS session. Idempotent — if the session already has a sandbox, returns the existing one. The sandbox is owned by the session_id; concurrent sessions cannot collide.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional human label for the sandbox (kept for back-compat; routing is by session_id). Use 'main' if unsure." },
        session_id: SESSION_ID_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "execute",
    description: "Execute a shell command inside this session's sandbox. Returns the command output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label (kept for back-compat; routing is by session_id)." },
        cmd: { type: "string", description: "Shell command to execute" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "cmd"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from this session's sandbox and return its text content. For large files, read a slice instead.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label (kept for back-compat; routing is by session_id)." },
        path: { type: "string", description: "Absolute path of the file inside the sandbox" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "path"],
    },
  },
  {
    name: "upload_artifact",
    description:
      "Upload a file from this session's sandbox to durable storage and get back a presigned download URL (valid 7 days). Use this to host a screenshot/PDF/CSV for embedding in a PR body — do NOT use external file hosts (imgur, 0x0.st, transfer.sh, catbox).",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label (kept for back-compat; routing is by session_id)." },
        path: { type: "string", description: "Absolute path of the file inside the sandbox, e.g. /home/user/keys.png" },
        name: { type: "string", description: "Optional artifact filename (defaults to the basename of path)" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "path"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function buildProxyUrl() {
  if (!VAULT_URL) return null;
  if (!VAULT_PROXY_TOKEN) return VAULT_URL;
  try {
    const u = new URL(VAULT_URL);
    u.username = "x";
    u.password = VAULT_PROXY_TOKEN;
    return u.toString();
  } catch { return VAULT_URL; }
}

// ── Session-scoped sandbox ownership (direct-e2b mode) ─────────────────────
// On a cache miss we hit /sandbox-id. The session row is authoritative; the
// Map is only an in-process accelerator.

function resolveSessionId(args) {
  // SESSION_ID env wins when set (platform mode keeps existing behavior); else
  // the tool-call arg is required. In the inline harness there is no other way
  // for the MCP server to know which session is calling.
  return ENV_SESSION_ID ?? (args && args.session_id) ?? null;
}

async function getStoredSandboxId(sid) {
  const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox-id`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GET /sandbox-id ${res.status}`);
  }
  const j = await res.json();
  return j.sandbox_id ?? null;
}

async function setStoredSandboxId(sid, sandbox_id) {
  const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox-id`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sandbox_id }),
  });
  if (!res.ok) throw new Error(`PUT /sandbox-id ${res.status}`);
}

async function clearStoredSandboxId(sid) {
  await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox-id`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).catch(() => {});
}

// Returns a usable Sandbox for this session, or null if none is registered or
// the registered one is no longer alive on e2b. Side effect: refreshes the
// keepalive timer on a hit (so the agent's next think doesn't reap it).
async function getSandboxFor(sid) {
  const cached = sessionSandboxes.get(sid);
  if (cached) {
    try { await cached.setTimeout(SANDBOX_TIMEOUT_MS); } catch {}
    return cached;
  }
  if (!BASE || !TOKEN) return null;
  let stored;
  try { stored = await getStoredSandboxId(sid); } catch (e) {
    console.error(`[sandbox-mcp] GET /sandbox-id failed for ${sid}: ${e.message}`);
    return null;
  }
  if (!stored) return null;
  try {
    const sandbox = await Sandbox.connect(stored, { apiKey: E2B_API_KEY });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    sessionSandboxes.set(sid, sandbox);
    return sandbox;
  } catch (e) {
    // Stored id points at a dead/reaped sandbox — clear it so the next provision
    // creates a fresh one cleanly.
    console.error(`[sandbox-mcp] reconnect to ${stored} failed for ${sid}: ${e.message}; clearing stored id`);
    await clearStoredSandboxId(sid);
    return null;
  }
}

async function killSandboxFor(sid) {
  const sb = sessionSandboxes.get(sid);
  sessionSandboxes.delete(sid);
  if (sb) { try { await sb.kill(); } catch {} }
  await clearStoredSandboxId(sid);
}

// ── Tool implementations ───────────────────────────────────────────────────

async function provision({ name, project_id, session_id }) {
  if (USE_DIRECT) {
    if (!E2B_API_KEY) return textResult("provision failed: E2B_API_KEY not set", true);
    const sid = resolveSessionId({ session_id });
    if (!sid) return textResult("provision failed: session_id is required in the inline-shared harness", true);
    // Idempotent: if the session already has a usable sandbox, return it.
    const existing = await getSandboxFor(sid);
    if (existing) {
      return textResult(`sandbox "${name ?? "main"}" already provisioned for this session (${existing.sandboxId}, template ${E2B_TEMPLATE})`);
    }
    try {
      const proxyUrl = buildProxyUrl();
      const sandbox = await Sandbox.create(E2B_TEMPLATE, {
        apiKey: E2B_API_KEY,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        envs: proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {},
      });
      sessionSandboxes.set(sid, sandbox);
      try { await setStoredSandboxId(sid, sandbox.sandboxId); }
      catch (e) {
        // Persistence failed — keep the cache entry so this call still works,
        // but log loudly: a subsequent call without the cache (e.g. after a
        // restart) won't find the sandbox.
        console.error(`[sandbox-mcp] WARN: failed to persist sandbox_id for ${sid}: ${e.message}`);
      }
      console.error(`[sandbox-mcp] provisioned direct: ${sandbox.sandboxId} session=${sid} template=${E2B_TEMPLATE}`);
      return textResult(`sandbox "${name ?? "main"}" ready (${sandbox.sandboxId}, template ${E2B_TEMPLATE})`);
    } catch (e) {
      return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, project_id }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.message ?? "sandbox provisioned");
  } catch (e) {
    return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function execute({ sandbox_name, cmd, session_id }) {
  if (USE_DIRECT) {
    const sid = resolveSessionId({ session_id });
    if (!sid) return textResult("execute failed: session_id is required in the inline-shared harness", true);
    const sandbox = await getSandboxFor(sid);
    if (!sandbox) return textResult(`execute failed: no sandbox for this session — call provision first`, true);
    try {
      // Keepalive: reset the shutdown timer to a fresh full window BEFORE running
      // so the sandbox can't expire mid-command or during the agent's next think
      // step. (`getSandboxFor` already touched it, but the cached path skips it.)
      await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
      const result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
      const out = (result.stdout ?? "") + (result.stderr ?? "");
      const code = result.exitCode ?? 0;
      return code === 0 ? textResult(out) : textResult(`${out}\n[exit ${code}]`, true);
    } catch (e) {
      const err = e && typeof e === "object" ? e : {};
      const out = (err.stdout ?? "") + (err.stderr ?? "");
      const msg = e instanceof Error ? e.message : String(e);
      return textResult(out ? `${out}\n[failed: ${msg}]` : `execute error: ${msg}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, cmd }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`execute failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.output ?? "");
  } catch (e) {
    return textResult(`execute error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

const READ_FILE_MAX_BYTES = 256 * 1024;

async function readFile({ sandbox_name, path, session_id }) {
  if (USE_DIRECT) {
    const sid = resolveSessionId({ session_id });
    if (!sid) return textResult("read_file failed: session_id is required in the inline-shared harness", true);
    const sandbox = await getSandboxFor(sid);
    if (!sandbox) return textResult(`read_file failed: no sandbox for this session — call provision first`, true);
    try {
      await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
      const content = await sandbox.files.read(path);
      if (content.length > READ_FILE_MAX_BYTES)
        return textResult(`error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice or split it.`, true);
      return textResult(content);
    } catch (e) {
      return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, path }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.content ?? "");
  } catch (e) {
    return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// MIME inferred from the file extension; falls back to octet-stream. Mirrors the
// allowlist the /artifacts endpoint enforces server-side.
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", json: "application/json", csv: "text/csv",
  md: "text/markdown", txt: "text/plain", py: "text/x-python",
  ts: "text/x-typescript", js: "text/x-javascript", zip: "application/zip",
  tar: "application/x-tar", gz: "application/gzip",
};
function mimeForPath(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Read a sandbox file's bytes as base64 — works in both modes: direct-e2b reads
// the bytes through the session's sandbox handle; platform mode shells out to
// `base64` inside the sandbox (binary-safe, since we transport the text).
async function readBase64(sandbox, sandbox_name, path, sid) {
  if (sandbox) {
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    const bytes = await sandbox.files.read(path, { format: "bytes" });
    return Buffer.from(bytes).toString("base64");
  }
  const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sandbox_name, cmd: `base64 -w0 ${JSON.stringify(path)}` }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return (json.output ?? "").trim();
}

async function uploadArtifact({ sandbox_name, path, name, session_id }) {
  const sid = resolveSessionId({ session_id });
  if (!sid) return textResult("upload_artifact failed: session_id is required (SESSION_ID env not set and none passed)", true);
  if (!BASE) return textResult("upload_artifact failed: LAP_BASE_URL not set", true);
  const fname = name || path.split("/").pop() || "artifact";
  let content;
  try {
    const sandbox = USE_DIRECT ? await getSandboxFor(sid) : null;
    if (USE_DIRECT && !sandbox) return textResult("upload_artifact failed: no sandbox for this session — call provision first", true);
    content = await readBase64(sandbox, sandbox_name, path, sid);
  } catch (e) {
    return textResult(`upload_artifact error reading ${path}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (!content) return textResult(`upload_artifact failed: ${path} is empty or unreadable`, true);
  const size = Buffer.from(content, "base64").length;
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: fname, mime_type: mimeForPath(fname), content, size }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`upload_artifact failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.url ?? JSON.stringify(json));
  } catch (e) {
    return textResult(`upload_artifact error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return; cleaningUp = true;
  // Intentionally do NOT kill the sandboxes or clear their stored ids on
  // harness shutdown. The session row still owns each sandbox by id; on the
  // next deploy a fresh harness will reconnect via `getSandboxFor` and the
  // session keeps its repo / running proxy / state across the restart. E2B's
  // 30-min idle reap takes care of sandboxes whose sessions never come back.
  sessionSandboxes.clear();
}
// `killSandboxFor` is defined above for the future case where a session ends
// (status flips to dead/done) and we want to actively release the e2b sandbox
// rather than wait for the 30-min idle reap. That lifecycle event lives in
// the platform, not in this MCP server, so the call site is a follow-up.
void killSandboxFor;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanupAll().finally(() => process.exit(0)));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision") return provision(args ?? {});
  if (name === "execute") return execute(args ?? {});
  if (name === "read_file") return readFile(args ?? {});
  if (name === "upload_artifact") return uploadArtifact(args ?? {});
  return textResult(`unknown tool: ${name}`, true);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sandbox-mcp] ready`);
