import { z } from "zod";
import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { httpError } from "@/api/types";
import { wrap } from "@/api/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SandboxFileSchema = z.object({
  name: z.string(),
  sandbox_path: z.string(),
  content: z.string(),
  content_type: z.string(),
  size: z.number(),
});

const CreateProjectBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  repo_url: z.string().url().optional().or(z.literal("")),
  env_vars: z.record(z.string()).default({}),
  allow_out: z.array(z.string()).default([]),
  deny_out: z.array(z.string()).default([]),
  files: z.array(SandboxFileSchema).default([]),
});

export const GET = wrap(async (req: Request) => {
  const identity = assertAuth(req);

  const rows = await prisma.project.findMany({
    where: { created_by: identity.user_id },
    orderBy: { created_at: "desc" },
  });

  return Response.json({ data: rows });
});

export const POST = wrap(async (req: Request) => {
  const identity = assertAuth(req);
  const body = CreateProjectBody.parse(await req.json());

  if (!body.name.trim()) {
    httpError(400, { error: "name is required" });
  }

  const created = await prisma.project.create({
    data: {
      name: body.name.trim(),
      description: body.description ?? null,
      repo_url: body.repo_url?.trim() || null,
      env_vars: body.env_vars as Prisma.InputJsonValue,
      allow_out: body.allow_out as Prisma.InputJsonValue,
      deny_out: body.deny_out as Prisma.InputJsonValue,
      files: body.files as Prisma.InputJsonValue,
      created_by: identity.user_id,
    },
  });

  return Response.json(created, { status: 201 });
});
