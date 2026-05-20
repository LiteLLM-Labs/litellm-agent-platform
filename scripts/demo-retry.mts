/**
 * Demo: exercises retryFetch end-to-end against a local HTTP server that
 * fails the first N attempts then succeeds. Used as proof for the retry-
 * mechanism PR. Run with:
 *
 *   npx tsx scripts/demo-retry.mts
 */
import http from "node:http";
import { fetch } from "undici";
import { retryFetch, isConnectError } from "../src/server/retryFetch";

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, () => resolve(srv));
  });
}

function port(srv: http.Server): number {
  const a = srv.address();
  if (!a || typeof a === "string") throw new Error("no port");
  return a.port;
}

function header(label: string) {
  console.log(`\n=== ${label} ===`);
}

async function scenario502Then200() {
  header("scenario 1: harness returns 502, 502, 200 — retry recovers");
  let n = 0;
  const srv = await listen((_req, res) => {
    n++;
    if (n < 3) {
      res.statusCode = 502;
      res.end("bad gateway");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "sess_demo" }));
    }
  });
  const url = `http://127.0.0.1:${port(srv)}/session`;
  const res = await retryFetch(() => fetch(url, { method: "POST", body: "{}" }), {
    retryOn5xx: true,
    label: "demo:create_session",
  });
  console.log(`  final status: ${res.status}`);
  console.log(`  body: ${await res.text()}`);
  console.log(`  total upstream attempts: ${n}`);
  srv.close();
}

async function scenarioConnectRefused() {
  header("scenario 2: connect refused on closed port — retry, then surface");
  // Bind & immediately close, so the port is dead. Three attempts all fail.
  const srv = await listen(() => {});
  const dead = port(srv);
  srv.close();
  try {
    await retryFetch(
      () =>
        fetch(`http://127.0.0.1:${dead}/`, {
          signal: AbortSignal.timeout(500),
        }),
      { retryOn5xx: true, label: "demo:dead_port", baseMs: 50, capMs: 200 },
    );
    console.log("  ERROR: expected throw, got success");
  } catch (err) {
    console.log(`  threw after retries (expected): isConnectError=${isConnectError(err)}`);
    console.log(`  err.message: ${(err as Error).message}`);
  }
}

async function scenario404NoRetry() {
  header("scenario 3: 404 caller-error — must NOT retry");
  let n = 0;
  const srv = await listen((_req, res) => {
    n++;
    res.statusCode = 404;
    res.end("not found");
  });
  const url = `http://127.0.0.1:${port(srv)}/missing`;
  const res = await retryFetch(() => fetch(url), {
    retryOn5xx: true,
    label: "demo:404",
  });
  console.log(`  final status: ${res.status}`);
  console.log(`  total upstream attempts: ${n}  (must be 1)`);
  srv.close();
}

async function scenarioMessageConnectRetry() {
  header("scenario 4: POST /message — connect retry only, 5xx surfaces");
  let n = 0;
  const srv = await listen((_req, res) => {
    n++;
    res.statusCode = 502;
    res.end("bad gateway");
  });
  const url = `http://127.0.0.1:${port(srv)}/session/x/message`;
  // No retryOn5xx — mimics harnessSendMessage policy.
  const res = await retryFetch(() => fetch(url, { method: "POST", body: "{}" }), {
    label: "demo:send_message",
  });
  console.log(`  final status: ${res.status}`);
  console.log(`  total upstream attempts: ${n}  (must be 1 — no 5xx retry)`);
  srv.close();
}

(async () => {
  await scenario502Then200();
  await scenarioConnectRefused();
  await scenario404NoRetry();
  await scenarioMessageConnectRetry();
  console.log("\nall scenarios complete.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
