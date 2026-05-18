/**
 * System-prompt self-edit tool spec — used by every harness adapter.
 *
 * Exposes the agent-facing `get_system_prompt` and `update_system_prompt`
 * tools as two pieces:
 *
 *   1. Input schemas (zod) + natural-language descriptions for the LLM.
 *   2. Handler functions that call back into the LAP HTTP API.
 *
 * Why this exists: the agent needs a way to durably edit its own persona
 * when the user teaches it conventions that belong in the system prompt
 * rather than in transient memory (e.g. "always @mention the user in
 * Slack replies"). Without these tools the agent has to ask a human to
 * paste a new prompt into the LAP dashboard.
 *
 * What's NOT here: the harness-specific tool-registration glue. Each
 * harness wraps these handlers in whatever tool API it exposes — for the
 * Claude Agent SDK that's `tool()` + `createSdkMcpServer({...})`.
 *
 * Important caveat the description surfaces to the model: PATCH-ing the
 * stored agent.prompt does NOT change the current session's system
 * prompt — the harness snapshots that at session-start. The edit takes
 * effect on the NEXT session.
 *
 * Env contract (read at tool-call time, not at module load):
 *
 *   LAP_BASE_URL     base URL of the platform (e.g. https://lap.example.com)
 *   AGENT_ID         which agent we operate on (the caller — self-edit only)
 *   LAP_AUTH_TOKEN   bearer token for /api/v1/managed_agents/*
 *
 * If any are missing, `systemPromptEnv()` returns null and the adapter is
 * expected to skip registering the tools — harness boots cleanly without
 * the self-edit capability, the LLM simply doesn't see those tool names.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface SystemPromptEnv {
  base_url: string;
  agent_id: string;
  auth_token: string;
}

export function systemPromptEnv(): SystemPromptEnv | null {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const auth_token = process.env.LAP_AUTH_TOKEN ?? "";
  if (!base_url || !agent_id || !auth_token) return null;
  return { base_url, agent_id, auth_token };
}

// ---------------------------------------------------------------------------
// Input schemas (zod raw shapes — harness adapters convert as needed)
// ---------------------------------------------------------------------------

// get_system_prompt takes no arguments — it always reads the calling
// agent's own prompt. Exported as an empty raw-shape so adapters can pass
// it through the same `tool(name, desc, shape, handler)` plumbing they use
// for the other tools.
export const getSystemPromptSchema = {} as const;

export const updateSystemPromptSchema = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "The new full system prompt. Replaces the current prompt entirely — " +
        "this is NOT a patch. Call get_system_prompt first if you want to " +
        "edit the existing prompt rather than rewrite it from scratch.",
    ),
} as const;

export type GetSystemPromptInput = Record<string, never>;
export type UpdateSystemPromptInput = {
  prompt: string;
};

// ---------------------------------------------------------------------------
// Natural-language descriptions (read by the LLM)
// ---------------------------------------------------------------------------

export const getSystemPromptDescription = [
  "Read your own current system prompt (the persona/instructions the",
  "platform persists for this agent). Use this before update_system_prompt",
  "so you can edit the existing prompt instead of rewriting it blind.",
  "Returns the prompt string as stored on the agent row — note that the",
  "running session's effective prompt was snapshotted at session-start and",
  "may differ if it was edited mid-session.",
].join(" ");

export const updateSystemPromptDescription = [
  "Replace your own stored system prompt with a new one. Use when the",
  "user teaches you a durable rule about how you should behave",
  "(persona, formatting conventions, default tone, etc.) that belongs in",
  "the system prompt rather than ephemeral memory. The new prompt fully",
  "replaces the old one — read it first with get_system_prompt if you",
  "want to amend rather than rewrite. IMPORTANT: the change takes effect",
  "on your NEXT session — the current session keeps the prompt it",
  "started with. Confirm scope with the user before calling: this is a",
  "permanent self-modification.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape — adapters re-pack into their harness's expected format
// ---------------------------------------------------------------------------

export interface SystemPromptToolResult {
  isError: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

export async function callGetSystemPrompt(
  env: SystemPromptEnv,
): Promise<SystemPromptToolResult> {
  const res = await callApi(env, "GET", agentUrl(env));
  if (!res.ok) {
    return {
      isError: true,
      text: `get_system_prompt failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  const prompt =
    res.data && typeof res.data === "object" && "prompt" in res.data
      ? (res.data as { prompt: string | null }).prompt
      : null;
  if (prompt === null || prompt === "") {
    return {
      isError: false,
      text: "(empty — this agent has no stored system prompt)",
    };
  }
  return { isError: false, text: prompt };
}

export async function callUpdateSystemPrompt(
  env: SystemPromptEnv,
  input: UpdateSystemPromptInput,
): Promise<SystemPromptToolResult> {
  const res = await callApi(env, "PATCH", agentUrl(env), {
    prompt: input.prompt,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `update_system_prompt failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  return {
    isError: false,
    text:
      "System prompt updated. Takes effect on the next session — the " +
      "current session keeps the prompt it started with.",
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function agentUrl(env: SystemPromptEnv): string {
  return `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}`;
}

async function callApi(
  env: SystemPromptEnv,
  method: "GET" | "PATCH",
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.auth_token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
