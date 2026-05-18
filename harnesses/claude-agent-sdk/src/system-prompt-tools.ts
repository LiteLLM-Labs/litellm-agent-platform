/**
 * Claude-Agent-SDK adapter for the shared managed-tools/system-prompt spec.
 *
 * All the real logic — schemas, descriptions, HTTP client — lives in
 * `@lap/managed-tools/system-prompt`. This file's only job is to bridge
 * that spec to the Claude Agent SDK's tool API (`tool()` +
 * `createSdkMcpServer`).
 *
 * Mirrors memory-tools.ts: when a future harness wants the same
 * self-edit capability, it imports from `@lap/managed-tools/system-prompt`
 * and writes its own ~40-line adapter the same way.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  callGetSystemPrompt,
  callUpdateSystemPrompt,
  getSystemPromptDescription,
  getSystemPromptSchema,
  systemPromptEnv,
  updateSystemPromptDescription,
  updateSystemPromptSchema,
  type UpdateSystemPromptInput,
} from "@lap/managed-tools/system-prompt";

export function buildSystemPromptMcpServer():
  | McpSdkServerConfigWithInstance
  | null {
  const env = systemPromptEnv();
  if (!env) return null;

  const getSystemPrompt = tool(
    "get_system_prompt",
    getSystemPromptDescription,
    getSystemPromptSchema,
    async () => {
      const out = await callGetSystemPrompt(env);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  const updateSystemPrompt = tool(
    "update_system_prompt",
    updateSystemPromptDescription,
    updateSystemPromptSchema,
    async (input: UpdateSystemPromptInput) => {
      const out = await callUpdateSystemPrompt(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  return createSdkMcpServer({
    name: "lap-self",
    version: "0.1.0",
    tools: [getSystemPrompt, updateSystemPrompt],
  });
}

export const SYSTEM_PROMPT_TOOL_NAMES = [
  "mcp__lap-self__get_system_prompt",
  "mcp__lap-self__update_system_prompt",
] as const;
