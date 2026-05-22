/**
 * Claude-Agent-SDK adapter for the shared managed-tools/automations spec.
 *
 * Bridges the harness-agnostic `@lap/managed-tools/automations` spec (schemas,
 * descriptions, HTTP client) to the Claude Agent SDK tool API. Lets the agent
 * schedule itself — `create_automation` / `list_automations` — so a user's
 * "run this every day at 9am" turns into a real cron automation.
 *
 * Mirrors memory-tools.ts; no-ops when the LAP env isn't present.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  automationsEnv,
  callCreateAutomation,
  callListAutomations,
  createAutomationDescription,
  createAutomationSchema,
  listAutomationsDescription,
  listAutomationsSchema,
  type CreateAutomationInput,
} from "@lap/managed-tools/automations";

export function buildAutomationsMcpServer(): McpSdkServerConfigWithInstance | null {
  const env = automationsEnv();
  if (!env) return null;

  const createAutomation = tool(
    "create_automation",
    createAutomationDescription,
    createAutomationSchema,
    async (input: CreateAutomationInput) => {
      const out = await callCreateAutomation(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  const listAutomations = tool(
    "list_automations",
    listAutomationsDescription,
    listAutomationsSchema,
    async () => {
      const out = await callListAutomations(env);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  return createSdkMcpServer({
    name: "lap-automations",
    version: "0.1.0",
    tools: [createAutomation, listAutomations],
  });
}

export const AUTOMATION_TOOL_NAMES = [
  "mcp__lap-automations__create_automation",
  "mcp__lap-automations__list_automations",
] as const;
