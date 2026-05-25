import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { createArtifact } from "@/server/artifacts";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateArtifactSchema = z.object({
  name: z.string().min(1).max(255),
  mime_type: z.string().min(1),
  content: z.string().min(1),
  size: z.number().int().min(1).max(100 * 1024 * 1024),
});

export async function POST(
  req: Request,
  { params }: { params: { session_id: string } },
) {
  try {
    assertAuth(req);

    const session = await prisma.session.findUnique({
      where: { session_id: params.session_id },
      select: { session_id: true },
    });

    if (!session) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }

    const body = await req.json();
    const { name, mime_type, content, size } = CreateArtifactSchema.parse(body);

    const artifact = await createArtifact({
      session_id: params.session_id,
      name,
      mime_type,
      content,
      size,
    });

    return Response.json(artifact);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "invalid request", details: error.issues }, { status: 400 });
    }

    console.error("Failed to create artifact:", error);
    return Response.json({ error: "internal server error" }, { status: 500 });
  }
}
