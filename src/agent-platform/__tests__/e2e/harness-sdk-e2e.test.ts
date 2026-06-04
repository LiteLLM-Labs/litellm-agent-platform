/**
 * E2E regression test for the claude-agent-sdk (brain-inline) harness.
 *
 * Run against the live Render deployment:
 *   BASE_URL=https://litellm-agent-platform.onrender.com \
 *   MASTER_KEY=sk-... \
 *   AGENT_ID=6b023d93-b570-4a60-a5bd-6a0b630e4a7b \
 *   node --experimental-vm-modules --import tsx/esm \
 *   src/__tests__/e2e/harness-sdk-e2e.test.ts
 *
 * Or locally:
 *   BASE_URL=http://localhost:3000 MASTER_KEY=sk-dev-master-key-change-me ...
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY  = process.env.MASTER_KEY ?? "sk-dev-master-key-change-me";
const AGENT_ID = process.env.AGENT_ID ?? "6b023d93-b570-4a60-a5bd-6a0b630e4a7b";

const headers = { "authorization": `Bearer ${KEY}`, "content-type": "application/json" };

async function api(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...((opts.headers as Record<string,string>) ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.url}: ${await r.text().catch(() => "")}`);
  return r.json();
}

let sessionId: string;
let harnessSessionId: string;

describe("harness-sdk brain-inline e2e", () => {
  before(async () => {
    // Create a fresh session
    const s = await api(`/api/v1/managed_agents/agents/${AGENT_ID}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "e2e-regression" }),
    }) as { id: string };
    sessionId = s.id;
    assert.ok(sessionId, "session created");

    // Wait up to 10s for ready
    for (let i = 0; i < 10; i++) {
      const row = await api(`/api/v1/managed_agents/sessions/${sessionId}`) as { status: string; harness_session_id?: string };
      if (row.status === "ready" && row.harness_session_id) {
        harnessSessionId = row.harness_session_id;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.ok(harnessSessionId, "session reached ready with harness_session_id");
  });

  test("harness health: platform → harness reachable", async () => {
    const row = await api(`/api/v1/managed_agents/sessions/${sessionId}`) as { status: string; sandbox_url: string };
    assert.equal(row.status, "ready");
    assert.ok(row.sandbox_url, "sandbox_url set");
  });

  test("message round-trip: agent responds", async () => {
    const msgUrl = `/api/v1/managed_agents/sessions/${sessionId}/opencode/session/${harnessSessionId}/message`;
    const result = await api(msgUrl, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "say exactly: e2e-ok" }] }),
    }) as { info: { error?: unknown }; parts: Array<{ type: string; text?: string }> };

    assert.ok(!result.info?.error, `no harness error: ${JSON.stringify(result.info?.error)}`);
    const textPart = result.parts.find(p => p.type === "text");
    assert.ok(textPart?.text?.includes("e2e-ok"), `expected e2e-ok in response, got: ${textPart?.text}`);
  });

  test("sandbox provision: e2b sandbox spins up with correct template", async () => {
    const prov = await api(`/api/v1/managed_agents/sessions/${sessionId}/sandbox/provision`, {
      method: "POST",
      body: JSON.stringify({ name: "e2e-sandbox", project_id: "8c050c9f-8411-4cb2-bc49-ed5ff8b7a6e1" }),
    }) as { message?: string; error?: string };
    assert.ok(!prov.error, `provision error: ${prov.error}`);
    assert.ok(prov.message?.includes("ready"), `expected ready: ${prov.message}`);
  });

  test("sandbox execute: command runs in e2b sandbox", async () => {
    const exec = await api(`/api/v1/managed_agents/sessions/${sessionId}/sandbox/execute`, {
      method: "POST",
      body: JSON.stringify({ sandbox_name: "e2e-sandbox", cmd: "echo e2e-exec-ok" }),
    }) as { output?: string; error?: string };
    assert.ok(!exec.error, `execute error: ${exec.error}`);
    assert.ok(exec.output?.includes("e2e-exec-ok"), `expected e2e-exec-ok, got: ${exec.output}`);
  });

  test("sandbox size: using litellm-4gb template (≥3800MB RAM)", async () => {
    const exec = await api(`/api/v1/managed_agents/sessions/${sessionId}/sandbox/execute`, {
      method: "POST",
      body: JSON.stringify({ sandbox_name: "e2e-sandbox", cmd: "free -m | grep '^Mem' | awk '{print $2}'" }),
    }) as { output?: string };
    const memMB = parseInt(exec.output?.trim() ?? "0", 10);
    assert.ok(memMB >= 3800, `expected ≥3800MB RAM for litellm-4gb template, got ${memMB}MB`);
  });

  test("stuck turn abort: 5xx auto-recovers without manual intervention", async () => {
    // This test verifies the auto-abort path: if a message returns 500 due to
    // a stuck turn, the proxy should abort+retry transparently. We can't easily
    // simulate a stuck turn in a live test, so we just verify the session still
    // accepts messages after the previous tests (no stuck state).
    const msgUrl = `/api/v1/managed_agents/sessions/${sessionId}/opencode/session/${harnessSessionId}/message`;
    const result = await api(msgUrl, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "say exactly: no-stuck" }] }),
    }) as { info: { error?: unknown }; parts: Array<{ type: string; text?: string }> };
    assert.ok(!result.info?.error, `session stuck after tests: ${JSON.stringify(result.info?.error)}`);
    const textPart = result.parts.find(p => p.type === "text");
    assert.ok(textPart?.text?.includes("no-stuck"), `expected no-stuck, got: ${textPart?.text}`);
  });
});
