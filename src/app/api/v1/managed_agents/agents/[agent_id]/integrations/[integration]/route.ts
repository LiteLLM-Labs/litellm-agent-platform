/**
 * /api/v1/managed_agents/agents/{agent_id}/integrations/{integration}
 *
 * GET    — return the current config (without secrets) and any active installs.
 * PUT    — create or update the config. Body: { client_id, client_secret,
 *          webhook_secret, enabled? }. Secrets get encrypted at rest.
 * DELETE — drop the config (cascades to installs + integration_sessions).
 *
 * The UI calls these to drive the per-agent Integrations panel. Browser-only
 * auth via Bearer MASTER_KEY (assertAuth).
 */

import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { wrap } from "@/server/route-helpers";
import { encryptToken } from "@/server/integrations/core/crypto";
import { getProvider } from "@/server/integrations/core/registry";
import { httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; integration: string }>;
}

// Returned shape — careful never to leak the encrypted secrets even in
// encoded form. The UI gets a boolean indicator of presence and metadata
// about the active installs.
function presentConfig(
  config: {
    agent_id: string;
    integration_id: string;
    enabled: boolean;
    client_id: string;
    created_at: Date;
    updated_at: Date;
  } | null,
  installs: Array<{
    install_id: string;
    workspace_id: string;
    workspace_name: string;
    expires_at: Date | null;
    created_at: Date;
  }>,
  webhookUrl: string,
) {
  if (config === null) {
    return {
      configured: false,
      enabled: false,
      installs: [] as never[],
      webhook_url: webhookUrl,
    };
  }
  return {
    configured: true,
    enabled: config.enabled,
    client_id: config.client_id,
    created_at: config.created_at.toISOString(),
    updated_at: config.updated_at.toISOString(),
    webhook_url: webhookUrl,
    installs: installs.map((i) => ({
      install_id: i.install_id,
      workspace_id: i.workspace_id,
      workspace_name: i.workspace_name,
      expires_at: i.expires_at?.toISOString() ?? null,
      created_at: i.created_at.toISOString(),
    })),
  };
}

function webhookUrlFor(req: Request, integration: string, agentId: string): string {
  const base = process.env.BASE_URL ?? new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}/api/integrations/webhooks/${encodeURIComponent(
    integration,
  )}/${encodeURIComponent(agentId)}`;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, integration: integrationId } = await ctx.params;
  const provider = getProvider(integrationId);
  if (!provider) httpError(404, `unknown integration "${integrationId}"`);

  const config = await prisma.agentIntegrationConfig.findUnique({
    where: { agent_id_integration_id: { agent_id, integration_id: integrationId } },
  });
  const installs = config
    ? await prisma.integrationInstall.findMany({
        where: { agent_id, integration_id: integrationId },
        orderBy: { created_at: "desc" },
        select: {
          install_id: true,
          workspace_id: true,
          workspace_name: true,
          expires_at: true,
          created_at: true,
        },
      })
    : [];
  return Response.json(presentConfig(config, installs, webhookUrlFor(req, integrationId, agent_id)));
});

const PutBody = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  enabled: z.boolean().optional(),
});

export const PUT = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id, integration: integrationId } = await ctx.params;
  const provider = getProvider(integrationId);
  if (!provider) httpError(404, `unknown integration "${integrationId}"`);

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (!agent) httpError(404, `agent "${agent_id}" not found`);

  const body = PutBody.parse(await req.json());
  const enabled = body.enabled ?? true;

  await prisma.agentIntegrationConfig.upsert({
    where: { agent_id_integration_id: { agent_id, integration_id: integrationId } },
    create: {
      agent_id,
      integration_id: integrationId,
      enabled,
      client_id: body.client_id,
      client_secret_enc: encryptToken(body.client_secret),
      webhook_secret_enc: encryptToken(body.webhook_secret),
      created_by: identity.user_id,
    },
    update: {
      enabled,
      client_id: body.client_id,
      client_secret_enc: encryptToken(body.client_secret),
      webhook_secret_enc: encryptToken(body.webhook_secret),
    },
  });

  const config = await prisma.agentIntegrationConfig.findUnique({
    where: { agent_id_integration_id: { agent_id, integration_id: integrationId } },
  });
  const installs = await prisma.integrationInstall.findMany({
    where: { agent_id, integration_id: integrationId },
    select: {
      install_id: true,
      workspace_id: true,
      workspace_name: true,
      expires_at: true,
      created_at: true,
    },
  });
  return Response.json(presentConfig(config, installs, webhookUrlFor(req, integrationId, agent_id)));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, integration: integrationId } = await ctx.params;
  await prisma.agentIntegrationConfig
    .delete({
      where: { agent_id_integration_id: { agent_id, integration_id: integrationId } },
    })
    .catch(() => {
      /* no-op if not present */
    });
  return Response.json({ ok: true });
});
