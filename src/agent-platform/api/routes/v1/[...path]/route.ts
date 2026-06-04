/**
 * Catch-all passthrough for /api/v1/* paths that don't have a more specific
 * handler (the managed-agents routes are explicit and win). Used by the UI
 * for /v1/models and /v1/mcp/server.
 *
 * MCP tool list (/mcp-rest/tools/list) lives at /api/mcp-rest/[...path],
 * not /api/v1, because LiteLLM exposes it without the /v1 prefix.
 */

import { forwardToLiteLLM } from "@/api/upstream-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function forward(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return forwardToLiteLLM(req, path, "v1");
}

export async function GET(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function POST(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function PUT(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function PATCH(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function DELETE(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function OPTIONS(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
