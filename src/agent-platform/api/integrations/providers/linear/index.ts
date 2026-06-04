/**
 * Linear integration.
 *
 * Wires together the four sibling modules:
 *   - oauth.ts    — install via Linear OAuth (`actor=app`)
 *   - webhook.ts  — verify + parse AgentSessionEvent
 *   - activity.ts — agentActivityCreate on outbound SessionEvent
 *   - prompt.ts   — issue → harness prompt
 *
 * `enabled()` returns false until the operator sets LINEAR_CLIENT_ID,
 * LINEAR_CLIENT_SECRET, and LINEAR_WEBHOOK_SECRET. The registry skips
 * disabled integrations; their routes return 404. This lets the package
 * ship with Linear support compiled in without forcing every deployment
 * to configure it.
 */

import type { Integration } from "../../core/types";
import { buildOAuthAdapter } from "./oauth";
import { buildWebhookAdapter } from "./webhook";
import { postActivity } from "./activity";

const integration: Integration = {
  id: "linear",
  displayName: "Linear",
  icon: "/integrations/linear.svg",
  docsUrl: "https://linear.app/developers/agents",

  enabled() {
    return Boolean(
      process.env.LINEAR_CLIENT_ID &&
        process.env.LINEAR_CLIENT_SECRET &&
        process.env.LINEAR_WEBHOOK_SECRET,
    );
  },

  oauth: buildOAuthAdapter(),
  webhook: buildWebhookAdapter(),

  async onSessionEvent(ctx) {
    await postActivity(integration, ctx);
  },
};

export default integration;
