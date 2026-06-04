/**
 * Linear webhook verification + parsing.
 *
 * Linear signs every webhook with HMAC-SHA256 of the raw body using the
 * signing secret configured on the OAuth app. The signature lives in the
 * `linear-signature` header as a lowercase hex digest.
 *
 * Payloads we care about: `AgentSessionEvent` with `action: "created"`
 * (delegation start) or `"prompted"` (followup comment). Everything else
 * gets translated to `{ kind: "ignore" }` so the dispatcher 204s out.
 *
 * Dedup loop: Linear also fires webhooks for the agent's own
 * `agentActivityCreate` calls. We compare `appUserId` on the payload against
 * the stored `app_user_id` in `IntegrationInstall.metadata` and ignore
 * matches — otherwise the integration would feedback-loop on itself.
 */

import { createHmac } from "node:crypto";
import { safeEqual } from "../../core/crypto";
import type { IntegrationInstall } from "@prisma/client";
import type {
  IntegrationEvent,
  WebhookAdapter,
} from "../../core/types";
import { issueToPrompt } from "./prompt";

const SIGNATURE_HEADER = "linear-signature";

/**
 * Read the webhook signing secret from env. Set by the operator when they
 * create the Linear OAuth app — same value across all workspaces that
 * install the app.
 */
function getSigningSecret(): string | null {
  return process.env.LINEAR_WEBHOOK_SECRET ?? null;
}

interface LinearAgentSession {
  id?: string;
  issue?: {
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    url?: string | null;
  } | null;
  comment?: { body?: string | null } | null;
  creator?: { name?: string | null } | null;
}

interface LinearAgentSessionEvent {
  type?: string;
  action?: string;
  organizationId?: string;
  appUserId?: string;
  agentSession?: LinearAgentSession;
  agentActivity?: { body?: string | null; userId?: string | null } | null;
}

export function buildWebhookAdapter(): WebhookAdapter {
  return {
    workspaceIdFromPayload(payload: unknown): string | null {
      const p = payload as LinearAgentSessionEvent;
      return typeof p?.organizationId === "string" ? p.organizationId : null;
    },

    verify(rawBody, headers, _install): boolean {
      const secret = getSigningSecret();
      if (!secret) return false;
      const got = headers.get(SIGNATURE_HEADER);
      if (!got) return false;
      const expected = createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
      return safeEqual(got, expected);
    },

    parse(payload, install: IntegrationInstall): IntegrationEvent {
      const evt = payload as LinearAgentSessionEvent;
      if (evt?.type !== "AgentSessionEvent") return { kind: "ignore" };

      const externalSessionId = evt.agentSession?.id;
      if (!externalSessionId) return { kind: "ignore" };

      if (evt.action === "created") {
        // Delegation start. No self-echo concern — Linear only fires
        // `created` on a fresh agent session (user-initiated).
        return {
          kind: "new_task",
          external_session_id: externalSessionId,
          prompt: issueToPrompt(evt.agentSession ?? {}),
          external_ref: evt.agentSession?.issue?.identifier ?? undefined,
        };
      }

      if (evt.action === "prompted") {
        const body = evt.agentActivity?.body?.trim();
        if (!body) return { kind: "ignore" };

        // Dedup self-echo: if Linear ever fires a `prompted` event whose
        // agentActivity was created by our own app-user, ignore it so the
        // dispatcher doesn't feedback-loop on the agent's own output.
        // Top-level `appUserId` on the payload identifies the recipient,
        // not the source — we use `agentActivity.userId` here, which is
        // the activity's creator when Linear sends one.
        const appUserId = (install.metadata as Record<string, unknown>)
          ?.app_user_id;
        const activityUserId = evt.agentActivity?.userId;
        if (
          typeof appUserId === "string" &&
          typeof activityUserId === "string" &&
          activityUserId === appUserId
        ) {
          return { kind: "ignore" };
        }

        return {
          kind: "followup",
          external_session_id: externalSessionId,
          body,
        };
      }

      return { kind: "ignore" };
    },
  };
}
