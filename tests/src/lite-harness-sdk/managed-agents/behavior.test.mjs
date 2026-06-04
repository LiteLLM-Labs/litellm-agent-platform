// Behavioral tests for review fixes #1 (status lifecycle), #2 (full-turn
// serialization), #3 (POST /events surfaces delivery failure). All offline,
// driven by the fake harness (env-selected modes).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createState, createApp } from "../../../../src/lite-harness-sdk/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, "fake-harness.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openSse(port, path, sink) {
  const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("data: ")) continue;
        const j = line.slice(6).trim();
        if (j) try { sink.push(JSON.parse(j)); } catch { /* partial */ }
      }
    });
  });
  req.on("error", () => {});
  return req;
}
async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(40); }
  return false;
}

/** Boot a server with the fake harness under the given env overrides. */
async function boot(env = {}) {
  const ctx = createState({ serverPath: FAKE, env: { ...process.env, ...env } });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const created = [];
  const api = {
    base,
    port,
    async create(agent = "claude-code") {
      const r = await fetch(`${base}/v1/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const body = await r.json();
      if (r.status === 201) created.push(body.id);
      return { status: r.status, body };
    },
    send(id, text) {
      return fetch(`${base}/v1/sessions/${id}/events`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
      });
    },
    async get(id) {
      const r = await fetch(`${base}/v1/sessions/${id}`);
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    },
    async cleanup() {
      for (const id of created) {
        try { await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
  return api;
}

// ── #1: status lifecycle ─────────────────────────────────────────────────────
test("#1 status: idle -> running -> idle across a turn", async () => {
  const api = await boot({ FAKE_MODE: "strict", FAKE_DELAY_MS: "300" });
  try {
    const { body: session } = await api.create();
    assert.equal(session.status, "idle", "new session is idle");

    await api.send(session.id, "hi");
    // mid-turn (fake delays 300ms): status should read running
    assert.ok(await waitFor(async () => (await api.get(session.id)).body?.status === "running"),
      "status flips to running during a turn");

    // after the turn settles: status idle
    assert.ok(await waitFor(async () => (await api.get(session.id)).body?.status === "idle"),
      "status returns to idle after the turn");
  } finally {
    await api.cleanup();
  }
});

test("#1 status: harness crash -> error", async () => {
  const api = await boot({ FAKE_CRASH: "1" });
  try {
    const { body: session } = await api.create();
    assert.ok(await waitFor(async () => (await api.get(session.id)).body?.status === "error"),
      "status becomes error when the harness exits non-zero");
  } finally {
    await api.cleanup();
  }
});

// ── #2: full-turn serialization ──────────────────────────────────────────────
test("#2 two rapid turns serialize — no 'turn already in progress'", async () => {
  const api = await boot({ FAKE_MODE: "strict", FAKE_DELAY_MS: "150" });
  try {
    const { body: session } = await api.create();
    const events = [];
    const sse = openSse(api.port, `/v1/sessions/${session.id}/events/stream`, events);
    await sleep(100);

    // fire two turns back-to-back; the second must wait for the first to finish
    await api.send(session.id, "first");
    await api.send(session.id, "second");

    // both turns complete (two idles); none rejected with the busy error
    await waitFor(() => events.filter((e) => e.type === "session.status_idle").length >= 2, 5000);
    const idles = events.filter((e) => e.type === "session.status_idle").length;
    const errors = events.filter((e) => e.type === "session.status_error");
    const msgs = events.filter((e) => e.type === "agent.message").length;

    assert.equal(errors.length, 0, `no error events (got: ${JSON.stringify(errors)})`);
    assert.equal(idles, 2, "both turns reached idle");
    assert.equal(msgs, 2, "both turns produced an assistant message");
    sse.destroy();
  } finally {
    await api.cleanup();
  }
});

// ── #3: POST /events surfaces a dead runtime ─────────────────────────────────
test("#3 POST to a dead runtime returns 409, not { ok: true }", async () => {
  const api = await boot({ FAKE_CRASH: "1" });
  try {
    const { body: session } = await api.create();
    // wait for the crash to propagate (runtime no longer alive)
    await waitFor(async () => (await api.get(session.id)).body?.status === "error");

    const res = await api.send(session.id, "are you there?");
    assert.equal(res.status, 409, "POST /events on a dead runtime is rejected");
    const body = await res.json();
    assert.ok(body.error, "409 body carries an error");
  } finally {
    await api.cleanup();
  }
});
