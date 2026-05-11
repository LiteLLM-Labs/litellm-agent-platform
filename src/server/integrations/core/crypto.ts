/**
 * Symmetric encryption for integration tokens at rest.
 *
 * Tokens (OAuth access + refresh) live in the Postgres `integration_install`
 * table. The DB is shared with the rest of LAP, so anyone with read access to
 * the DB would otherwise see plaintext tokens that grant write to the user's
 * Linear / Slack / GitHub workspace. AES-256-GCM with a 32-byte key from the
 * `INTEGRATION_TOKEN_KEY` env var blocks that.
 *
 * Format on disk: `enc:v1:<base64(iv | tag | ciphertext)>` where iv is 12
 * bytes, tag is 16 bytes, ciphertext is variable-length.
 *
 * Plaintext fallback: if `INTEGRATION_TOKEN_KEY` is unset and `NODE_ENV !==
 * "production"`, tokens are stored as-is with a one-time warning. This makes
 * local development easy; production deployments must set the key or the
 * encrypt path throws on first use.
 *
 * Generating a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let warnedAboutMissingKey = false;
let _cachedKey: Buffer | null | undefined; // undefined = not yet resolved

function getKey(): Buffer | null {
  if (_cachedKey !== undefined) return _cachedKey;
  const raw = process.env.INTEGRATION_TOKEN_KEY;
  if (!raw) {
    _cachedKey = null;
    return null;
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "INTEGRATION_TOKEN_KEY must be a base64-encoded 32-byte key. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  _cachedKey = buf;
  return buf;
}

function warnOnceAboutPlaintext(): void {
  if (warnedAboutMissingKey) return;
  warnedAboutMissingKey = true;
  console.warn(
    "[integrations/crypto] INTEGRATION_TOKEN_KEY is not set — integration " +
      "tokens will be stored as plaintext in the database. This is only " +
      "acceptable for local development. Set INTEGRATION_TOKEN_KEY in production.",
  );
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  if (key === null) {
    const allowPlaintext =
      process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test";
    if (!allowPlaintext) {
      throw new Error(
        "INTEGRATION_TOKEN_KEY is required outside development/test (NODE_ENV=" +
          (process.env.NODE_ENV ?? "unset") +
          ")",
      );
    }
    warnOnceAboutPlaintext();
    return plaintext;
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) {
    // Legacy plaintext (pre-encryption) or dev-mode-no-key. Pass through.
    return stored;
  }
  const key = getKey();
  if (key === null) {
    throw new Error(
      "INTEGRATION_TOKEN_KEY is required to decrypt a stored encrypted token",
    );
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("malformed encrypted token");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Constant-time string compare. Re-exported here so providers don't each
 * reach for `node:crypto` directly when verifying signatures.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
