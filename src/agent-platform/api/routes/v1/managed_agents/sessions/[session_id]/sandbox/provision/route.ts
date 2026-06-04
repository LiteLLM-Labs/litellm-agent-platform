/**
 * POST /api/v1/managed_agents/sessions/[session_id]/sandbox/provision
 *
 * Called by the claude-code-brain-inline harness when its `provision` MCP tool
 * fires. Spins up a K8s sandbox pod for the named project and registers the
 * resulting URL in the in-process sandboxMap so subsequent /execute calls can
 * reach it.
 *
 * Body: { name: string, project_id: string }
 *   - name       — logical sandbox name within the session (e.g. "main")
 *   - project_id — ID of a project entry in agent.projects (JSON array)
 *
 * The agent's repo_url is overridden with the project's repo_url before the
 * pod is created so the sandbox clones the correct repository.
 */

import { ZodError, z } from "zod";

import type { Prisma } from "@prisma/client";

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { provisionSandbox } from "@/api/tools/sandboxTools";
import { HttpError, httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

const ProvisionBody = z.object({
  name: z.string().min(1, "name is required"),
  project_id: z.string().min(1).optional(),
});

interface ProjectEntry {
  id: string;
  repo_url: string;
  branch?: string;
  [key: string]: unknown;
}

function isProjectEntry(v: Prisma.JsonValue): v is ProjectEntry & Prisma.JsonObject {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, Prisma.JsonValue>).id === "string" &&
    typeof (v as Record<string, Prisma.JsonValue>).repo_url === "string"
  );
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = ProvisionBody.parse(await req.json());

    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    // Extract existing sandboxes map from the session row so provisionSandbox
    // can merge into it without a second DB read.
    const rawSandboxes = (row as Record<string, unknown>).sandboxes;
    const existingSandboxes: Record<string, string> =
      rawSandboxes !== null &&
      typeof rawSandboxes === "object" &&
      !Array.isArray(rawSandboxes)
        ? (rawSandboxes as Record<string, string>)
        : {};

    const agent = row.agent;

    // Locate the project within the agent's projects JSON array.
    // agent.projects is Prisma.JsonValue — cast to array safely.
    const rawProjects: Prisma.JsonValue[] = Array.isArray(agent.projects)
      ? (agent.projects as Prisma.JsonValue[])
      : [];
    // project_id is optional — omitted by harnesses that don't use projects
    // (e.g. opencode). When present, override repo_url/branch from the project.
    let agentWithProject = agent;
    if (body.project_id) {
      const project = rawProjects.find(
        (p): p is ProjectEntry & Prisma.JsonObject =>
          isProjectEntry(p) && (p as Record<string, Prisma.JsonValue>).id === body.project_id,
      );
      if (!project) {
        httpError(
          404,
          `project ${body.project_id} not found on agent ${agent.agent_id}`,
        );
      }
      agentWithProject = {
        ...agent,
        repo_url: project!.repo_url as string,
        branch: typeof project!.branch === "string" ? project!.branch : "main",
      };
    }

    await provisionSandbox(session_id, body.name, agentWithProject, existingSandboxes);

    return Response.json({ message: `sandbox '${body.name}' ready` });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error("sandbox/provision route error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
