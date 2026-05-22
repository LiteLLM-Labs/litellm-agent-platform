/**
 * Slack tool spec — lets the agent post messages to Slack channels or users.
 *
 * Exposes one agent-facing tool as a harness-agnostic piece (input schema +
 * description + handler): `post_slack_message`. When the agent wants to send
 * a status update, notify a user, or post to a channel, it calls this tool.
 *
 * Same shape and env contract as memory.ts / automations.ts. If the env is
 * incomplete, `slackEnv()` returns null and the adapter skips registering the
 * tool — the harness boots cleanly without it.
 *
 * Env contract (read at tool-call time):
 *
 *   SLACK_BOT_TOKEN    Slack bot OAuth token (xoxb-...). Arrives as a vault
 *                      stub (`stub_slack_bot_token_xxxx`) in the harness pod;
 *                      the vault sidecar swaps it for the real value at egress.
 *                      Set via CONTAINER_ENV_SLACK_BOT_TOKEN on the platform.
 *
 * The harness-specific registration glue lives in the adapter:
 *   harnesses/claude-agent-sdk/src/slack-tools.ts
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface SlackEnv {
  bot_token: string;
}

export interface SlackEnvStatus {
  env: SlackEnv | null;
  missing: string[];
}

export function slackEnvStatus(): SlackEnvStatus {
  const bot_token = process.env.SLACK_BOT_TOKEN ?? "";
  const missing: string[] = [];
  if (!bot_token) missing.push("SLACK_BOT_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return { env: { bot_token }, missing: [] };
}

let slackEnvWarnedOnce = false;

export function slackEnv(): SlackEnv | null {
  const status = slackEnvStatus();
  if (status.env) return status.env;
  if (!slackEnvWarnedOnce) {
    slackEnvWarnedOnce = true;
    console.warn(
      `[slack] disabled — missing env: ${status.missing.join(", ")}. ` +
        `post_slack_message will NOT be registered. ` +
        `Fix: set CONTAINER_ENV_SLACK_BOT_TOKEN on the platform.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input schemas (zod raw shapes)
// ---------------------------------------------------------------------------

export const postSlackMessageSchema = {
  channel: z
    .string()
    .min(1)
    .describe(
      "Channel ID (e.g. C01234ABCDE), channel name (e.g. #general), or user ID " +
        "(e.g. U01234ABCDE) to send a direct message. Channel IDs and user IDs " +
        "are preferred over names — they are stable and unambiguous.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Message text to send. Supports Slack mrkdwn formatting: *bold*, _italic_, " +
        "`code`, ```code block```, and <https://url|link text>.",
    ),
  thread_ts: z
    .string()
    .optional()
    .describe(
      "Thread timestamp to reply to an existing thread. Omit to post a new " +
        "top-level message. Format: '1234567890.123456' (from a previous message's ts field).",
    ),
} as const;

export type PostSlackMessageInput = {
  channel: string;
  text: string;
  thread_ts?: string;
};

// ---------------------------------------------------------------------------
// Natural-language description (read by the LLM)
// ---------------------------------------------------------------------------

export const postSlackMessageDescription = [
  "Post a message to a Slack channel or send a direct message to a user.",
  "Use this to send status updates, notify teammates of progress, share",
  "results, or alert on errors. Supply a channel ID (C...), channel name",
  "(#general), or user ID (U...) for direct messages. Supports Slack",
  "mrkdwn formatting and optional thread replies.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape
// ---------------------------------------------------------------------------

export interface SlackToolResult {
  isError: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function callPostSlackMessage(
  env: SlackEnv,
  input: PostSlackMessageInput,
): Promise<SlackToolResult> {
  const body: Record<string, string> = {
    channel: input.channel,
    text: input.text,
  };
  if (input.thread_ts) {
    body.thread_ts = input.thread_ts;
  }

  const res = await rawCall(env, "https://slack.com/api/chat.postMessage", body);
  if (!res.ok) {
    return {
      isError: true,
      text: `post_slack_message failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }

  const data = res.data as { ok: boolean; error?: string; ts?: string; channel?: string };
  if (!data.ok) {
    return {
      isError: true,
      text: `post_slack_message failed: ${data.error ?? "unknown Slack API error"}`,
    };
  }

  return {
    isError: false,
    text: `Message posted successfully. channel=${data.channel ?? input.channel} ts=${data.ts ?? ""}`,
  };
}

// ---------------------------------------------------------------------------
// internals — proxy-aware fetch (mirrors memory.ts / automations.ts)
// ---------------------------------------------------------------------------

let _proxyAgent: ProxyAgent | null | undefined;

function proxyDispatcher(): ProxyAgent | undefined {
  if (_proxyAgent !== undefined) return _proxyAgent ?? undefined;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  _proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return _proxyAgent ?? undefined;
}

async function rawCall(
  env: SlackEnv,
  url: string,
  body: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.bot_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
