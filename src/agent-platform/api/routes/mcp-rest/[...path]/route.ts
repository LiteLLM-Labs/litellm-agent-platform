/**
 * Passthrough for LiteLLM's MCP REST endpoints — most importantly
 * /mcp-rest/tools/list, used by the new-agent page to enumerate tools per
 * MCP server. LiteLLM exposes these without a /v1 prefix.
 */

import { forwardToLiteLLM } from "@/api/upstream-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function forward(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return forwardToLiteLLM(req, path, "mcp-rest");
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
