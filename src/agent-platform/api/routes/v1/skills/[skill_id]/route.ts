import { assertAgentScopeOrMaster, assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { UpdateSkillBody, toApiSkill, httpError } from "@/api/types";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ skill_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { skill_id } = await ctx.params;
  const row = await prisma.skill.findUnique({ where: { skill_id } });
  if (row === null || row.created_by !== user_id) httpError(404, `skill '${skill_id}' not found`);
  return Response.json(toApiSkill(row));
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  // Accept either a UI master-key call or an agent token with "skills" scope.
  const identity = assertAgentScopeOrMaster(req, "skills");
  const { skill_id } = await ctx.params;
  const body = UpdateSkillBody.parse(await req.json());

  const existing = await prisma.skill.findUnique({ where: { skill_id } });
  // UI calls are scoped to the authenticated user; agent calls may update any skill.
  if (existing === null) httpError(404, `skill '${skill_id}' not found`);
  if (identity.source === "ui" && existing.created_by !== "ui") httpError(404, `skill '${skill_id}' not found`);

  // Version the current content before overwriting so the change is reversible.
  if (body.content !== undefined && body.content !== existing.content) {
    const last = await prisma.skillVersion.findFirst({
      where: { skill_id },
      orderBy: { version_number: "desc" },
      select: { version_number: true },
    });
    await prisma.skillVersion.create({
      data: {
        skill_id,
        content: existing.content,
        version_number: (last?.version_number ?? 0) + 1,
        changed_by_session_id:
          identity.source === "agent"
            ? (req.headers.get("x-session-id") ?? null)
            : null,
      },
    });
  }

  const updated = await prisma.skill.update({
    where: { skill_id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.content !== undefined && { content: body.content }),
    },
  });
  return Response.json(toApiSkill(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { skill_id } = await ctx.params;
  const existing = await prisma.skill.findUnique({ where: { skill_id } });
  if (existing === null || existing.created_by !== user_id) httpError(404, `skill '${skill_id}' not found`);
  await prisma.skill.delete({ where: { skill_id } });
  return new Response(null, { status: 204 });
});
