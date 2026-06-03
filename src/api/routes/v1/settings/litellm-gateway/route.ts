import { z } from "zod";

import { assertAuth } from "@/api/auth";
import {
  getLiteLLMGatewayStatus,
  saveLiteLLMGatewayConfig,
} from "@/api/app-settings";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateLiteLLMGatewayBody = z.object({
  base_url: z.string().url(),
  api_key: z.string().min(1),
});

export const GET = wrap(async (req: Request) => {
  assertAuth(req);
  return Response.json(await getLiteLLMGatewayStatus());
});

export const PATCH = wrap(async (req: Request) => {
  assertAuth(req);
  const body = UpdateLiteLLMGatewayBody.parse(await req.json());
  return Response.json(
    await saveLiteLLMGatewayConfig({
      base_url: body.base_url,
      api_key: body.api_key,
    }),
  );
});
