import { assertAuth } from "@/server/auth";
import { listTemplates } from "@/server/templates";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req) => {
  assertAuth(req);
  return Response.json(listTemplates());
});
