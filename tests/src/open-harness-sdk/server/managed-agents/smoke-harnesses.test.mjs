// Live smoke test: drive the REAL ../server.mjs (real provider SDKs) through the
// LiteLLM gateway for each harness. SKIPPED unless LITELLM_API_KEY is set, since
// it needs network + a gateway key + the provider SDKs installed under server/.
//
//   export LITELLM_API_BASE="https://gateway.litellm-sandbox.ai"
//   export LITELLM_API_KEY="<gateway key>"
//   node --test tests/src/open-harness-sdk/server/managed-agents/smoke-harnesses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createState, createApp } from "../../../../../src/open-harness-sdk/server/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESSES = ["claude-code", "codex", "pi-ai"];
const haveKey = Boolean(process.env.LITELLM_API_KEY);

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
        if (!j) continue;
        try { sink.push(JSON.parse(j)); } catch { /* partial */ }
      }
    });
  });
  req.on("error", () => {});
  return req;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(200); }
  return false;
}

test("live: every harness answers through the LiteLLM gateway", { skip: haveKey ? false : "LITELLM_API_KEY not set" }, async () => {
  const serverPath = resolve(__dirname, "../../../../../src/open-harness-sdk/server/server.mjs");
  const ctx = createState({ serverPath, env: process.env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const agent of HARNESSES) {
      const cr = await fetch(`${base}/v1/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      assert.equal(cr.status, 201, `[${agent}] create -> 201`);
      const { id } = await cr.json();

      const events = [];
      const sse = openSse(port, `/v1/sessions/${id}/events/stream`, events);
      await sleep(200);

      const send = await fetch(`${base}/v1/sessions/${id}/events`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: `Reply with exactly: hello from ${agent}` }] }] }),
      });
      assert.equal(send.status, 200, `[${agent}] send -> 200`);

      const settled = await waitFor(
        () => events.some((e) => e.type === "session.status_idle" || e.type === "session.status_error"),
        90000,
      );
      assert.ok(settled, `[${agent}] session should settle within 90s`);

      const err = events.find((e) => e.type === "session.status_error");
      assert.ok(!err, `[${agent}] must not error: ${err?.error ?? ""}`);

      const text = events
        .filter((e) => e.type === "agent.message")
        .flatMap((m) => (m.content || []).map((b) => b.text || ""))
        .join("");
      assert.ok(text.trim().length > 0, `[${agent}] should produce assistant text`);

      sse.destroy();
      const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
      assert.equal(del.status, 200, `[${agent}] delete -> 200`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
