CREATE TABLE "project" (
  "project_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "repo_url" TEXT,
  "env_vars" JSONB NOT NULL DEFAULT '{}',
  "allow_out" JSONB NOT NULL DEFAULT '[]',
  "deny_out" JSONB NOT NULL DEFAULT '[]',
  "files" JSONB NOT NULL DEFAULT '[]',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_pkey" PRIMARY KEY ("project_id")
);

CREATE INDEX "project_created_by_idx" ON "project"("created_by");
