/**
 * Sender identity — wire schema + harness-prompt formatter.
 *
 * Webhook adapters (Slack, …) attach an `IntegrationSender` to inbound
 * events. The dispatcher forwards it to the v1 session-create and
 * send-message routes, which use `withSenderHeader` here to prepend a
 * one-line "[from: …]" tag to the harness prompt. Without that prefix the
 * agent would see only the message text and have no way to address the
 * user back ("hi @ishaan_jaff …") or @-mention them in the originating
 * medium.
 *
 * The wire format is identical on both routes so providers (Slack today,
 * Discord/Linear-next/…) need to learn one schema, not two.
 *
 * The schema is intentionally permissive on `provider` (any non-empty
 * string) so a new provider doesn't require a schema change here — the
 * value is treated as an opaque label in the formatter.
 */

import { z } from "zod";
import type { IntegrationSender } from "./types";

export const SenderBody = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  handle: z.string().optional(),
  display_name: z.string().optional(),
});

export type SenderBody = z.infer<typeof SenderBody>;

/**
 * Render a sender as the Slack `<@U…>` mention format when we have a
 * Slack id. Other providers fall back to "@handle" if known, or the raw
 * id. Returned string is the literal token the agent should paste back
 * into a reply to @-mention the user.
 */
function mentionToken(sender: IntegrationSender): string {
  if (sender.provider === "slack") return `<@${sender.id}>`;
  if (sender.handle) return `@${sender.handle}`;
  return sender.id;
}

/**
 * Prepend a `[from: …]` header to `text` so the harness sees who sent
 * the message. Returns `text` unchanged when `sender` is undefined —
 * non-integration callers (the dashboard UI's "Send message" form,
 * direct API users) keep the existing zero-overhead behavior.
 *
 * Format:
 *   [from: <@U123> handle=ishaan_jaff name="Ishaan Jaffer" via slack]
 *
 *   <original text>
 *
 * Fields after the mention token are omitted when the provider couldn't
 * resolve them. The trailing blank line keeps the prompt readable even
 * if the user message is itself a single line.
 */
export function withSenderHeader(
  text: string,
  sender: IntegrationSender | undefined,
): string {
  if (!sender) return text;
  const parts: string[] = [`[from: ${mentionToken(sender)}`];
  if (sender.handle) parts.push(`handle=${sender.handle}`);
  if (sender.display_name) parts.push(`name="${sender.display_name}"`);
  parts.push(`via ${sender.provider}]`);
  const header = parts.join(" ");
  return text ? `${header}\n\n${text}` : header;
}
