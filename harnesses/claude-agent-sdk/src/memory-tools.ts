/**
 * In-process MCP server exposing `save_memory` and `search_memory` to the
 * Claude Agent SDK. Calls back into the platform's HTTP API:
 *
 *   POST  {LAP_BASE_URL}/api/v1/managed_agents/agents/{AGENT_ID}/memory
 *   GET   {LAP_BASE_URL}/api/v1/managed_agents/agents/{AGENT_ID}/memory?q=...&tag=...
 *
 * Auth is the shared MASTER_KEY (passed in as LAP_AUTH_TOKEN). The platform's
 * server-side route handler validates the bearer against MASTER_KEY directly.
 *
 * If any of LAP_BASE_URL / AGENT_ID / LAP_AUTH_TOKEN are missing (e.g. local
 * dev without the platform reachable), `buildMemoryMcpServer()` returns null
 * and the harness simply doesn't register the tools — the agent will still
 * see the pre-loaded memory block in its system prompt and can complete the
 * task without saving anything mid-run.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

interface MemoryEnv {
  base_url: string;
  agent_id: string;
  auth_token: string;
}

function readEnv(): MemoryEnv | null {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const auth_token = process.env.LAP_AUTH_TOKEN ?? "";
  if (!base_url || !agent_id || !auth_token) return null;
  return { base_url, agent_id, auth_token };
}

function memoryUrl(env: MemoryEnv, suffix = "", qs: URLSearchParams | null = null): string {
  const base = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/memory${suffix}`;
  return qs && qs.toString() ? `${base}?${qs.toString()}` : base;
}

async function callApi(
  env: MemoryEnv,
  method: "GET" | "POST",
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

/**
 * Build the in-process MCP server config to pass into the SDK's
 * `mcpServers` option. Returns null when the memory endpoint isn't
 * configured (LAP_BASE_URL/AGENT_ID/LAP_AUTH_TOKEN missing) so the harness
 * can skip registration cleanly.
 */
export function buildMemoryMcpServer(): McpSdkServerConfigWithInstance | null {
  const env = readEnv();
  if (!env) return null;

  const saveMemory = tool(
    "save_memory",
    [
      "Save a durable lesson the user has just taught you, so it applies to",
      "every future run of this agent. Use when the user gives generalizable",
      "feedback ('next time', 'always', 'never', 'going forward', or",
      "explicitly types 'remember:'). Phrase the lesson generically — for",
      "future tasks, not for this PR specifically.",
    ].join(" "),
    {
      text: z
        .string()
        .min(1)
        .describe(
          "The lesson, phrased generically. One rule per call. Markdown OK.",
        ),
      tags: z
        .array(z.string())
        .max(4)
        .optional()
        .describe(
          "1-4 short kebab-case labels for grouping/filtering (e.g. ui, antd, pr, security).",
        ),
      type: z
        .enum(["convention", "constraint", "reference", "preference"])
        .optional()
        .describe(
          "convention=how things are done; constraint=hard rule; reference=pointer to docs; preference=soft style.",
        ),
      priority: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("Higher = surfaces first in pre-load and search. Default 0."),
    },
    async (input) => {
      const res = await callApi(env, "POST", memoryUrl(env), {
        text: input.text,
        tags: input.tags ?? [],
        type: input.type,
        priority: input.priority,
        source: "agent",
        source_session_id: process.env.SESSION_ID || undefined,
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `save_memory failed (HTTP ${res.status}): ${
                res.error ?? JSON.stringify(res.data)
              }`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved memory:\n${JSON.stringify(res.data, null, 2)}`,
          },
        ],
      };
    },
  );

  const searchMemory = tool(
    "search_memory",
    [
      "Search this agent's active memory for relevant lessons. MANDATORY",
      "checkpoint before you finalize and file a PR — build a query from what",
      "you actually changed (files, features, components) and read each",
      "returned memory. If your work violates one, fix the violation before",
      "filing. Optional mid-task when making a stylistic decision.",
    ].join(" "),
    {
      query: z
        .string()
        .optional()
        .describe(
          "Substring filter (case-insensitive) on memory text. Omit to list all.",
        ),
      tag: z
        .string()
        .optional()
        .describe(
          "Restrict to memories that include this tag (e.g. 'ui', 'security').",
        ),
    },
    async (input) => {
      const qs = new URLSearchParams();
      if (input.query) qs.set("q", input.query);
      if (input.tag) qs.set("tag", input.tag);
      const res = await callApi(env, "GET", memoryUrl(env, "", qs));
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `search_memory failed (HTTP ${res.status}): ${
                res.error ?? JSON.stringify(res.data)
              }`,
            },
          ],
          isError: true,
        };
      }
      const rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No matching memories." }] };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(rows, null, 2) },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "lap-memory",
    version: "0.1.0",
    tools: [saveMemory, searchMemory],
  });
}

export const MEMORY_TOOL_NAMES = [
  "mcp__lap-memory__save_memory",
  "mcp__lap-memory__search_memory",
] as const;
