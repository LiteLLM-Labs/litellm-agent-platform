/**
 * Standalone subscriber for end-to-end proof.
 *
 * Bypasses the full worker (no reconciler, no warm-pool, no ghost-sweep).
 * Subscribes to one harness pod's /event SSE — the harness emits
 * `SessionEvent` JSON directly via its `ClaudeSdkTranslator`, so the
 * platform side just parses + persists. No platform-side translator.
 *
 * Usage:
 *   SESSION_ID=<lap session uuid> SANDBOX_URL=http://localhost:4098 \
 *     npx tsx scripts/proof-subscriber.mts
 */
import type { SessionEvent } from "@lap/harness-shared/session-event";

import { harnessOpenEventStream } from "../src/server/harness";
import { appendSessionEvent } from "../src/server/sessionEvents";

const SESSION_ID = process.env.SESSION_ID;
const SANDBOX_URL = process.env.SANDBOX_URL;

if (!SESSION_ID || !SANDBOX_URL) {
  console.error("SESSION_ID and SANDBOX_URL env vars are required");
  process.exit(2);
}

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[subscriber] received ${sig}, aborting`);
    ac.abort();
  });
}

console.log(
  `[subscriber] connecting session=${SESSION_ID} sandbox=${SANDBOX_URL}`,
);

const upstream = await harnessOpenEventStream({
  sandbox_url: SANDBOX_URL,
  signal: ac.signal,
});
if (!upstream.body) {
  console.error("[subscriber] no body on SSE response");
  process.exit(3);
}
console.log(`[subscriber] connected; reading events`);

const reader = upstream.body.getReader();
const decoder = new TextDecoder();
let pending = "";

while (!ac.signal.aborted) {
  const { value, done } = await reader.read();
  if (done) break;
  pending += decoder.decode(value, { stream: true });
  for (;;) {
    const idx = pending.indexOf("\n\n");
    if (idx < 0) break;
    const frame = pending.slice(0, idx);
    pending = pending.slice(idx + 2);
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trimStart();
      if (!raw) continue;
      let event: SessionEvent;
      try {
        event = JSON.parse(raw) as SessionEvent;
      } catch {
        continue;
      }
      if (!event || typeof event.type !== "string") continue;
      console.log(`[subscriber] event type=${event.type}`);
      try {
        const seq = await appendSessionEvent(SESSION_ID, event);
        console.log(`[subscriber]   -> persisted seq=${seq}`);
      } catch (e) {
        console.error(`[subscriber]   -> persist failed:`, e);
      }
    }
  }
}
console.log("[subscriber] loop exited");
process.exit(0);
