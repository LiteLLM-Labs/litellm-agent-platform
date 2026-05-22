/**
 * Automations tool spec — lets the agent schedule itself.
 *
 * Exposes two agent-facing tools as harness-agnostic pieces (input schemas +
 * descriptions + handlers): `create_automation` and `list_automations`. When a
 * user asks the agent to "do this every day at 9am", the agent calls
 * `create_automation` and reports back what it scheduled.
 *
 * Same shape and env contract as memory.ts (LAP_BASE_URL / AGENT_ID /
 * LAP_ACCESS_TOKEN / LAP_REFRESH_TOKEN, vault stubs swapped at egress). If the
 * env is incomplete, `automationsEnv()` returns null and the adapter skips
 * registering the tools — the harness boots cleanly without them.
 *
 * The harness-specific registration glue lives in the adapter, e.g.
 * harnesses/claude-agent-sdk/src/automations-tools.ts.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface AutomationsEnv {
  base_url: string;
  agent_id: string;
  access_token: string;
  refresh_token: string;
}

export interface AutomationsEnvStatus {
  env: AutomationsEnv | null;
  missing: string[];
}

export function automationsEnvStatus(): AutomationsEnvStatus {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const access_token =
    process.env.LAP_ACCESS_TOKEN ?? process.env.LAP_AUTH_TOKEN ?? "";
  const refresh_token = process.env.LAP_REFRESH_TOKEN ?? "";
  const missing: string[] = [];
  if (!base_url) missing.push("LAP_BASE_URL");
  if (!agent_id) missing.push("AGENT_ID");
  if (!access_token) missing.push("LAP_ACCESS_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return { env: { base_url, agent_id, access_token, refresh_token }, missing: [] };
}

let automationsEnvWarnedOnce = false;

export function automationsEnv(): AutomationsEnv | null {
  const status = automationsEnvStatus();
  if (status.env) return status.env;
  if (!automationsEnvWarnedOnce) {
    automationsEnvWarnedOnce = true;
    console.warn(
      `[automations] disabled — missing env: ${status.missing.join(", ")}. ` +
        `create_automation/list_automations will NOT be registered. ` +
        `Fix: set the listed vars on the harness pod's container env.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input schemas (zod raw shapes)
// ---------------------------------------------------------------------------

export const createAutomationSchema = {
  instruction: z
    .string()
    .min(1)
    .describe(
      "What the agent should do each time this runs — sent as the initial prompt of a fresh session. Be specific and self-contained (the run has no chat context).",
    ),
  cron_expr: z
    .string()
    .min(1)
    .describe(
      "Standard 5-field cron, evaluated in UTC. Examples: every 10 minutes '*/10 * * * *'; hourly '0 * * * *'; daily 9am UTC '0 9 * * *'; weekdays 9am '0 9 * * 1-5'; Mondays 9am '0 9 * * 1'. Convert the user's local time to UTC.",
    ),
  name: z
    .string()
    .optional()
    .describe("Short label for the automation (e.g. 'Morning PR digest')."),
} as const;

export const listAutomationsSchema = {} as const;

export type CreateAutomationInput = {
  instruction: string;
  cron_expr: string;
  name?: string;
};

export type ListAutomationsInput = Record<string, never>;

// ---------------------------------------------------------------------------
// Natural-language descriptions (read by the LLM)
// ---------------------------------------------------------------------------

export const createAutomationDescription = [
  "Schedule this agent to run itself on a recurring cron schedule. Use when",
  "the user asks you to do something on a schedule ('every day at 9am',",
  "'every 10 minutes', 'each Monday'). Translate their cadence into a 5-field",
  "UTC cron and write a self-contained instruction for the run. After it",
  "succeeds, tell the user exactly what you scheduled (the cadence + what it",
  "will do).",
].join(" ");

export const listAutomationsDescription = [
  "List this agent's existing scheduled automations (cadence, instruction,",
  "enabled state). Use to check what's already scheduled before creating a",
  "new one, or when the user asks what schedules are set up.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape
// ---------------------------------------------------------------------------

export interface AutomationsToolResult {
  isError: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function callCreateAutomation(
  env: AutomationsEnv,
  input: CreateAutomationInput,
): Promise<AutomationsToolResult> {
  const res = await callApi(env, "POST", automationsUrl(env), {
    instruction: input.instruction,
    cron_expr: input.cron_expr,
    name: input.name,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `create_automation failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  return {
    isError: false,
    text: `Created automation:\n${JSON.stringify(res.data, null, 2)}`,
  };
}

export async function callListAutomations(
  env: AutomationsEnv,
): Promise<AutomationsToolResult> {
  const res = await callApi(env, "GET", automationsUrl(env));
  if (!res.ok) {
    return {
      isError: true,
      text: `list_automations failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) {
    return { isError: false, text: "No automations scheduled yet." };
  }
  return { isError: false, text: JSON.stringify(rows, null, 2) };
}

// ---------------------------------------------------------------------------
// internals (mirrors memory.ts: proxy-aware fetch + refresh-on-401 retry)
// ---------------------------------------------------------------------------

function automationsUrl(env: AutomationsEnv): string {
  return `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/automations`;
}

let _proxyAgent: ProxyAgent | null | undefined;

function proxyDispatcher(): ProxyAgent | undefined {
  if (_proxyAgent !== undefined) return _proxyAgent ?? undefined;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  _proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return _proxyAgent ?? undefined;
}

let cachedAccessToken: string | null = null;

function currentBearer(env: AutomationsEnv): string {
  return cachedAccessToken ?? env.access_token;
}

async function callApi(
  env: AutomationsEnv,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const firstAttempt = await rawCall(env, method, url, body, currentBearer(env));
  if (firstAttempt.status !== 401 || !env.refresh_token) {
    return firstAttempt;
  }
  const refreshed = await refreshAccessToken(env);
  if (!refreshed) return firstAttempt;
  cachedAccessToken = refreshed;
  return rawCall(env, method, url, body, refreshed);
}

async function rawCall(
  env: AutomationsEnv,
  method: "GET" | "POST",
  url: string,
  body: unknown,
  bearer: string,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(dispatcher !== undefined && { dispatcher }),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function refreshAccessToken(env: AutomationsEnv): Promise<string | null> {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(`${env.base_url}/api/v1/agent-auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: env.refresh_token }),
      ...(dispatcher !== undefined && { dispatcher }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return typeof json.access_token === "string" && json.access_token.length > 0
      ? json.access_token
      : null;
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
