import { assertAuth } from "@/api/auth";
import { listTemplates } from "@/api/templates";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req) => {
  assertAuth(req);
  return Response.json(listTemplates());
});
