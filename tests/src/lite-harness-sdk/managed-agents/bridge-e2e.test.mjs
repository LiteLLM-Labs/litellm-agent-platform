// Deterministic end-to-end test of the HTTP <-> subprocess bridge.
// Spawns the FAKE harness (not a real provider), so it needs no network, no
// gateway key, and no provider SDKs. Proves: create -> stream (SSE) -> send ->
// translated events arrive live -> history -> delete.
//
// SSE is consumed via node:http (not global fetch): undici buffers
// text/event-stream bodies, so it is the wrong client for asserting live SSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createState, createApp } from "../../../../src/lite-harness-sdk/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Open an SSE connection with node:http; push parsed events into `sink`.
 *  Returns the http.ClientRequest so the caller can abort it. */
function openSse(port, path, sink) {
  const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop(); // keep trailing partial line
      for (const line of parts) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try { sink.push(JSON.parse(json)); } catch { /* partial/non-JSON */ }
      }
    });
  });
  req.on("error", () => {}); // aborted during teardown — expected
  return req;
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test("bridge-e2e: full session lifecycle through fake harness", async () => {
  const fakeHarnessPath = resolve(__dirname, "fake-harness.mjs");
  const ctx = createState({ serverPath: fakeHarnessPath, env: process.env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const sseEvents = [];
  let sseReq;

  try {
    // 1. create session
    const createRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code" }),
    });
    assert.equal(createRes.status, 201, "POST /v1/sessions -> 201");
    const session = await createRes.json();
    const id = session.id;
    assert.ok(typeof id === "string" && id.startsWith("session_"), `bad id: ${id}`);

    // 2. open SSE (node:http) BEFORE sending
    sseReq = openSse(port, `/v1/sessions/${id}/events/stream`, sseEvents);
    await new Promise((r) => setTimeout(r, 150)); // let the subscription attach

    // 3. send a user message (fire-and-forget)
    const sendRes = await fetch(`${base}/v1/sessions/${id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    assert.equal(sendRes.status, 200, "POST /events -> 200");

    // 4. agent.message + session.status_idle arrive live on the SSE stream
    const gotMsg = await waitFor(() => sseEvents.some((e) => e.type === "agent.message"));
    assert.ok(gotMsg, "agent.message should arrive on SSE within timeout");
    const agentMsg = sseEvents.find((e) => e.type === "agent.message");
    assert.equal(agentMsg.content[0].text, "hello from claude-code");

    const gotIdle = await waitFor(() => sseEvents.some((e) => e.type === "session.status_idle"));
    assert.ok(gotIdle, "session.status_idle should arrive on SSE within timeout");

    // 5. history contains the user + agent messages
    const listBody = await (await fetch(`${base}/v1/sessions/${id}/events`)).json();
    assert.ok(Array.isArray(listBody.data), "history.data is an array");
    assert.ok(listBody.data.some((e) => e.type === "user.message"), "history has user.message");
    assert.ok(listBody.data.some((e) => e.type === "agent.message"), "history has agent.message");

    // 6. delete
    const delRes = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200, "DELETE -> 200");
    assert.equal((await delRes.json()).deleted, true, "deleted:true");
  } finally {
    try { sseReq?.destroy(); } catch { /* ignore */ }
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
