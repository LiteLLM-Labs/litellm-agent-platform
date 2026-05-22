/**
 * Claude-Agent-SDK adapter for the shared managed-tools/slack spec.
 *
 * All the real logic — schema, description, HTTP client — lives in
 * `@lap/managed-tools/slack`. This file's only job is to bridge that
 * spec to the Claude Agent SDK's tool API (`tool()` + `createSdkMcpServer`).
 *
 * When a future harness wants Slack, it imports from `@lap/managed-tools/slack`
 * and writes its own ~30-line adapter the same way.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  callPostSlackMessage,
  slackEnv,
  postSlackMessageDescription,
  postSlackMessageSchema,
  type PostSlackMessageInput,
} from "@lap/managed-tools/slack";

export function buildSlackMcpServer(): McpSdkServerConfigWithInstance | null {
  const env = slackEnv();
  if (!env) return null;

  const postSlackMessage = tool(
    "post_slack_message",
    postSlackMessageDescription,
    postSlackMessageSchema,
    async (input: PostSlackMessageInput) => {
      const out = await callPostSlackMessage(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  return createSdkMcpServer({
    name: "lap-slack",
    version: "0.1.0",
    tools: [postSlackMessage],
  });
}

export const SLACK_TOOL_NAMES = [
  "mcp__lap-slack__post_slack_message",
] as const;
