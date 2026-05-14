// Minimal HTTPS forward proxy that swaps stub credentials for real values
// at egress. Agents see only stub_xxx in their env; the wire carries real.
//
// Boots:
//   1. Reads REAL_<KEY> env vars (one per credential).
//   2. Mints a fresh stub for each.
//   3. Writes /lap-shared/env (KEY=stub) — harness sources this so its env
//      contains only stubs.
//   4. Loads the cluster CA from a K8s-secret-mounted dir (cert is also
//      baked into the harness image trust store at build time).
//   5. Listens on 127.0.0.1:14322 as an HTTPS CONNECT proxy. On every
//      tunnelled connection, MITMs TLS with a leaf cert minted on demand,
//      scans request headers + text-y bodies for known stubs, swaps them
//      for the matching real value, forwards to the real upstream.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);
const ALG: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const PORT = Number(process.env.VAULT_PORT ?? 14322);
const SHARED = process.env.VAULT_SHARED_DIR ?? "/lap-shared";
const CA_DIR = process.env.VAULT_CA_DIR ?? "/etc/vault-ca";

// Maximum number of interception records retained in memory. Old entries
// drop off once the buffer is full — this is a debug aid, not an audit log.
const INTERCEPTION_BUFFER_SIZE = 100;

// Stub → REAL_<KEY> name. We keep this alongside KV so each interception
// record can name the credential that was swapped without ever surfacing the
// real value. The KV map can't carry both because real values must stay
// fungible (the swap path only cares about the bytes to substitute in).
const STUB_TO_CRED = new Map<string, string>();

// What we record per interception. `real_tail` is the last 2 chars of the
// real value — exposing more would leak credential type (e.g. "ghp_" prefix
// reveals a GitHub token). 2 chars is enough to distinguish "did vault swap
// the right secret?" without recreating a usable prefix.
interface InterceptionRealFingerprint {
  stub: string;
  credential: string;
  real_tail: string;
}

interface InterceptionRecord {
  timestamp: string;
  method: string;
  host: string;
  path: string;
  stubs_swapped: string[];
  real_value_fingerprint: InterceptionRealFingerprint[];
}

const interceptions: InterceptionRecord[] = [];

function recordInterception(rec: InterceptionRecord): void {
  interceptions.push(rec);
  if (interceptions.length > INTERCEPTION_BUFFER_SIZE) {
    interceptions.shift();
  }
}

function realTail(value: string): string {
  // slice(-2) handles short values (1 char → 1 char, 0 char → ""). We
  // intentionally do not pad — the consumer renders "…" + tail and an empty
  // tail simply renders "…".
  return value.slice(-2);
}

// 1-2. Stubs from env.
const KV = new Map<string, string>();
const stubLines: string[] = [];
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("REAL_") || !v) continue;
  const ns = k.slice(5).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const stub = `stub_${ns}_${randomBytes(4).toString("hex")}`;
  KV.set(stub, v);
  STUB_TO_CRED.set(stub, k.slice(5));
  stubLines.push(`${k.slice(5)}=${stub}`);
}
console.log(`[vault] ${KV.size} secret(s) registered`);

// 4. Load cluster CA.
function pemDer(pem: string, label: string): ArrayBuffer {
  const m = pem.match(new RegExp(`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`));
  if (!m) throw new Error(`PEM missing ${label}`);
  const b = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const caCertPem = await fs.readFile(`${CA_DIR}/tls.crt`, "utf8");
const caKeyPem = await fs.readFile(`${CA_DIR}/tls.key`, "utf8");
const caCert = new x509.X509Certificate(caCertPem);
// WebCrypto only imports PKCS#8. OpenSSL 1.1.x's `openssl req -newkey` emits
// PKCS#1 (`BEGIN RSA PRIVATE KEY`) by default — refuse with a clear remediation
// rather than crashing in importKey() with an opaque error.
if (!caKeyPem.includes("BEGIN PRIVATE KEY")) {
  throw new Error(
    `CA key at ${CA_DIR}/tls.key must be PKCS#8 (-----BEGIN PRIVATE KEY-----). ` +
    `Regenerate with: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out tls.key`,
  );
}
const caKey = await crypto.subtle.importKey("pkcs8", pemDer(caKeyPem, "PRIVATE KEY"), ALG, true, ["sign"]);

const leafCache = new Map<string, { cert: string; key: string }>();
async function leafFor(host: string) {
  const cached = leafCache.get(host);
  if (cached) return cached;
  const k = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: String(Math.floor(Math.random() * 1e10)),
    subject: `CN=${host}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 24 * 3600_000),
    signingKey: caKey,
    publicKey: k.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], true),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
      await x509.SubjectKeyIdentifierExtension.create(k.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert, false),
    ],
  });
  const keyDer = await crypto.subtle.exportKey("pkcs8", k.privateKey);
  const keyB64 = (Buffer.from(keyDer).toString("base64").match(/.{1,64}/g) ?? []).join("\n");
  const out = { cert: cert.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${keyB64}\n-----END PRIVATE KEY-----\n` };
  leafCache.set(host, out);
  return out;
}

// 5. Proxy.
function swap(s: string): { out: string; hits: string[] } {
  let out = s;
  const hits: string[] = [];
  for (const [stub, real] of KV) {
    if (out.includes(stub)) {
      out = out.split(stub).join(real);
      hits.push(stub);
    }
  }
  return { out, hits };
}

const isTextLike = (ct: string) =>
  /^(application\/(json|xml|x-www-form-urlencoded|x-ndjson|graphql)|text\/)/i.test(ct);

const proxy = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", stubs: KV.size }));
    return;
  }
  // Debug surface: dump the in-memory ring buffer of interceptions as JSON.
  // No auth — vault is reachable only from inside the cluster (pod-to-pod),
  // and the records are deliberately scrubbed to never carry full real
  // values. The platform proxies this through an authenticated session
  // route; nothing else should be calling it.
  if (req.method === "GET" && req.url === "/interceptions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(interceptions));
    return;
  }
  // Same surface, scoped to clearing the buffer. Useful when reproducing a
  // bug — reset between runs so the table only shows the new attempt.
  if (req.method === "POST" && req.url === "/interceptions/reset") {
    interceptions.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", cleared: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

proxy.on("connect", async (req, socket) => {
  const [host, portStr] = (req.url ?? "").split(":");
  const port = Number(portStr) || 443;
  socket.on("error", (e) => console.warn(`[vault] client ${host}: ${e.message}`));
  socket.write("HTTP/1.1 200 OK\r\nProxy-Agent: vault\r\n\r\n");

  let leaf;
  try {
    leaf = await leafFor(host);
  } catch (e) {
    console.warn(`[vault] leaf ${host}: ${(e as Error).message}`);
    socket.destroy();
    return;
  }
  const ts = new tls.TLSSocket(socket, {
    isServer: true,
    cert: leaf.cert,
    key: leaf.key,
    ALPNProtocols: ["http/1.1"],
  });
  ts.on("error", (e) => console.warn(`[vault] tls ${host}: ${e.message}`));

  const inner = http.createServer(async (areq, ares) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of areq) chunks.push(c as Buffer);
      let body = Buffer.concat(chunks);

      const hdrs: Record<string, string> = {};
      const hits: string[] = [];
      for (const [k, v] of Object.entries(areq.headers)) {
        if (v === undefined) continue;
        const val = Array.isArray(v) ? v.join(", ") : v;
        const r = swap(val);
        hits.push(...r.hits);
        hdrs[k] = r.out;
      }
      hdrs.host = host + (port !== 443 ? `:${port}` : "");
      delete hdrs["proxy-connection"];
      delete hdrs["proxy-authorization"];
      delete hdrs["content-length"];

      const ct = String(areq.headers["content-type"] ?? "");
      const ce = String(areq.headers["content-encoding"] ?? "").toLowerCase().trim();
      const identityEnc = ce === "" || ce === "identity";
      if (isTextLike(ct) && identityEnc && body.length > 0) {
        const r = swap(body.toString("utf8"));
        hits.push(...r.hits);
        body = Buffer.from(r.out);
      } else if (!identityEnc && body.length > 0) {
        console.warn(`[vault] ${areq.method} ${host}${areq.url} body content-encoding=${ce} — skipping body swap`);
      }
      if (body.length > 0) hdrs["content-length"] = String(body.length);
      const uniqueHits = [...new Set(hits)];
      if (uniqueHits.length) {
        console.log(`[vault] ${areq.method} ${host}${areq.url} swapped ${uniqueHits.length} stub(s)`);
      }
      // Persist a structured record of every proxied request — including
      // zero-swap ones — so the inspector can answer both "did vault swap?"
      // and "did the request even make it through vault?".
      recordInterception({
        timestamp: new Date().toISOString(),
        method: String(areq.method ?? "GET"),
        host,
        path: String(areq.url ?? "/"),
        stubs_swapped: uniqueHits,
        real_value_fingerprint: uniqueHits.map((stub) => ({
          stub,
          credential: STUB_TO_CRED.get(stub) ?? "unknown",
          real_tail: realTail(KV.get(stub) ?? ""),
        })),
      });

      const ureq = https.request(
        { host, port, method: areq.method, path: areq.url, headers: hdrs, servername: host },
        (ures) => {
          ares.writeHead(ures.statusCode ?? 502, ures.statusMessage ?? "", ures.headers);
          ures.pipe(ares);
        },
      );
      ureq.on("error", (e) => {
        console.warn(`[vault] upstream ${host}: ${e.message}`);
        try { ares.writeHead(502); ares.end(`vault upstream: ${e.message}`); } catch { /* */ }
      });
      if (body.length > 0) ureq.write(body);
      ureq.end();
    } catch (e) {
      console.warn(`[vault] handler ${host}: ${(e as Error).message}`);
      try { ares.writeHead(500); ares.end(); } catch { /* */ }
    }
  });
  inner.emit("connection", ts);
});

// 6. Listen, THEN write the stub file. The harness entrypoint waits for
//    /lap-shared/env to exist before sourcing — this ordering guarantees
//    that by the time the harness starts making proxied requests, the
//    proxy is already accepting connections.
// Bind on 0.0.0.0 so the platform pod can reach the /interceptions debug
// surface via the sandbox pod's IP. The agent inside the same pod still
// hits us at 127.0.0.1 through its HTTPS_PROXY. There's no Service /
// NodePort / Ingress publishing port 14322, so this stays cluster-internal.
const BIND_HOST = process.env.VAULT_BIND_HOST ?? "0.0.0.0";
await new Promise<void>((r) => proxy.listen(PORT, BIND_HOST, () => r()));
await fs.mkdir(SHARED, { recursive: true });
await fs.writeFile(`${SHARED}/env`, stubLines.join("\n") + "\n", { mode: 0o644 });
await fs.writeFile(`${SHARED}/ca.crt`, caCertPem, { mode: 0o644 });
console.log(`[vault] listening on ${BIND_HOST}:${PORT}; wrote ${SHARED}/env`);
