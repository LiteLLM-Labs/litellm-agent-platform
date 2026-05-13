// Persistent cluster-level CA + per-host leaf cert issuance.
//
// The CA cert is baked into the harness image at build time
// (harnesses/lap-vault/ca.crt -> /usr/local/share/ca-certificates) so every
// binary in the sandbox trusts it on boot — including the bundled `claude`
// native binary which ignores NODE_EXTRA_CA_CERTS.
//
// The matching CA private key lives in the K8s secret `lap-vault-ca`,
// mounted at /etc/lap-vault-ca/tls.key (read-only) on this container only.
// The harness container never sees the key.

import { promises as fs } from "node:fs";
import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";
import path from "node:path";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

export interface CA {
  certPem: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface Leaf {
  cert: string; // PEM
  key: string;  // PEM
}

const leafCache = new Map<string, Leaf>();

const ALG: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function exportPkcs8(key: CryptoKey): Promise<string> {
  const buf = await crypto.subtle.exportKey("pkcs8", key);
  return toPem(Buffer.from(buf), "PRIVATE KEY");
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function pemToDer(pem: string, label: string): ArrayBuffer {
  const re = new RegExp(`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`);
  const m = pem.match(re);
  if (!m) throw new Error(`PEM missing ${label} block`);
  const b64 = m[1].replace(/\s+/g, "");
  const bin = Buffer.from(b64, "base64");
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
}

export async function bootstrapCa(sharedDir: string): Promise<CA> {
  // Load the CA from the secret-mounted directory. The cert is also baked
  // into the harness image, so the agent already trusts whatever leaves
  // we sign with this key.
  const caDir = process.env.LAP_VAULT_CA_DIR ?? "/etc/lap-vault-ca";
  const [certPem, keyPem] = await Promise.all([
    fs.readFile(path.join(caDir, "tls.crt"), "utf8"),
    fs.readFile(path.join(caDir, "tls.key"), "utf8"),
  ]);

  // peculiar/x509 expects the private key as a CryptoKey. PEM may carry
  // either "PRIVATE KEY" (PKCS8) or "RSA PRIVATE KEY" (PKCS1) — openssl
  // emits PKCS8 by default with -nodes, so we import PKCS8 directly.
  const keyDer = pemToDer(keyPem, "PRIVATE KEY");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    ALG,
    true,
    ["sign"],
  );

  // We don't separately need the publicKey beyond what leaf issuance
  // already derives from the cert, but the CA type carries it for parity
  // with the previous shape. Re-derive it from the cert.
  const caCert = new x509.X509Certificate(certPem);
  const publicKey = await caCert.publicKey.export(ALG, ["verify"], crypto);

  // Mirror the cert into /lap-shared for any client that still wants to
  // pick it up at runtime (defensive — image trust store is the load-
  // bearing path now).
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(sharedDir, "ca.crt"), certPem, { mode: 0o644 });

  return { certPem, privateKey, publicKey };
}

export async function issueLeaf(ca: CA, host: string): Promise<Leaf> {
  const cached = leafCache.get(host);
  if (cached) return cached;

  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);

  // Parse the CA cert so we can use it as issuer.
  const caCert = new x509.X509Certificate(ca.certPem);

  // gnutls (Debian's git is libcurl-gnutls) strictly requires AuthorityKey-
  // Identifier on leaves to chain back to the CA's SubjectKeyIdentifier.
  // OpenSSL tolerates a missing AKI but gnutls rejects. Add both.
  const ski = await x509.SubjectKeyIdentifierExtension.create(keys.publicKey);
  const aki = await x509.AuthorityKeyIdentifierExtension.create(caCert, false);

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: Math.floor(Math.random() * 1e10).toString(),
    subject: `CN=${host}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 24 * 3600_000),
    signingKey: ca.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, 0, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], true),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
      ski,
      aki,
    ],
  });

  const out: Leaf = {
    cert: leaf.toString("pem"),
    key: await exportPkcs8(keys.privateKey),
  };
  leafCache.set(host, out);
  return out;
}
