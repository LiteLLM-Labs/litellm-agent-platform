/**
 * POST /api/integrations/webhooks/{integration}
 *
 * Single inbound endpoint for every registered integration. The dispatcher
 * looks up the provider by the URL param, validates the signature against
 * the matching IntegrationInstall, and acts on the canonical event.
 *
 * This route is intentionally NOT behind `assertAuth` — webhooks come from
 * external services with their own signing scheme. The dispatcher calls
 * `provider.webhook.verify(...)` on every request.
 */

import { handleInbound } from "@/api/integrations/core/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string }>;
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { integration } = await ctx.params;
  return handleInbound(integration, req);
}
