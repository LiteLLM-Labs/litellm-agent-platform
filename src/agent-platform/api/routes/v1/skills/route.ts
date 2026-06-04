import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { CreateSkillBody, toApiSkill } from "@/api/types";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req) => {
  const { user_id } = assertAuth(req);
  const rows = await prisma.skill.findMany({
    where: { created_by: user_id },
    orderBy: { created_at: "desc" },
  });
  return Response.json({ data: rows.map(toApiSkill) });
});

export const POST = wrap(async (req) => {
  const { user_id } = assertAuth(req);
  const body = CreateSkillBody.parse(await req.json());
  const row = await prisma.skill.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      content: body.content,
      created_by: user_id,
    },
  });
  return Response.json(toApiSkill(row), { status: 201 });
});
