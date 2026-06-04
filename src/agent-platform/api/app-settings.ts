import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { prisma } from "@/api/db";
import { env } from "@/api/env";

const PREFIX = "master:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const LITELLM_GATEWAY_KEY = "litellm_gateway";

export interface LiteLLMGatewayConfig {
  base_url: string;
  api_key: string;
}

export interface LiteLLMGatewayStatus {
  base_url: string;
  has_api_key: boolean;
  configured: boolean;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(env.MASTER_KEY, "utf8").digest();
}

function encryptWithMasterKey(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptWithMasterKey(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("malformed app setting ciphertext");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function parseGatewayConfig(stored: string): LiteLLMGatewayConfig {
  const parsed = JSON.parse(decryptWithMasterKey(stored)) as {
    base_url?: unknown;
    api_key?: unknown;
  };
  return {
    base_url:
      typeof parsed.base_url === "string"
        ? normalizeBaseUrl(parsed.base_url)
        : "",
    api_key: typeof parsed.api_key === "string" ? parsed.api_key : "",
  };
}

export async function getSavedLiteLLMGatewayConfig(): Promise<LiteLLMGatewayConfig | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: LITELLM_GATEWAY_KEY },
  });
  if (!row) return null;
  return parseGatewayConfig(row.value);
}

export async function getEffectiveLiteLLMGatewayConfig(): Promise<LiteLLMGatewayConfig> {
  const saved = await getSavedLiteLLMGatewayConfig();
  if (saved?.base_url && saved.api_key) return saved;
  return {
    base_url: normalizeBaseUrl(env.LITELLM_API_BASE),
    api_key: env.LITELLM_API_KEY,
  };
}

export async function getLiteLLMGatewayStatus(): Promise<LiteLLMGatewayStatus> {
  const config = await getEffectiveLiteLLMGatewayConfig();
  return {
    base_url: config.base_url,
    has_api_key: config.api_key.length > 0,
    configured: config.base_url.length > 0 && config.api_key.length > 0,
  };
}

export async function saveLiteLLMGatewayConfig(
  config: LiteLLMGatewayConfig,
): Promise<LiteLLMGatewayStatus> {
  const base_url = normalizeBaseUrl(config.base_url);
  const api_key = config.api_key.trim();
  const value = encryptWithMasterKey(JSON.stringify({ base_url, api_key }));
  await prisma.appSetting.upsert({
    where: { key: LITELLM_GATEWAY_KEY },
    create: { key: LITELLM_GATEWAY_KEY, value },
    update: { value },
  });
  return {
    base_url,
    has_api_key: api_key.length > 0,
    configured: base_url.length > 0 && api_key.length > 0,
  };
}
