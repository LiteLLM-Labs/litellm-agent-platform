-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "managed_agent" (
    "agent_id" TEXT NOT NULL,
    "agent_name" TEXT,
    "model" TEXT NOT NULL,
    "prompt" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "harness_id" TEXT NOT NULL DEFAULT 'opencode',
    "repo_url" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "pfp_url" TEXT,
    "mcp_servers" JSONB NOT NULL DEFAULT '[]',
    "env_vars" JSONB NOT NULL DEFAULT '{}',
    "task_definition_arn" TEXT NOT NULL,
    "container_port" INTEGER NOT NULL DEFAULT 4096,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "managed_agent_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "managed_agent_session" (
    "session_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "phase" TEXT,
    "phase_detail" TEXT,
    "task_arn" TEXT,
    "sandbox_url" TEXT,
    "harness_session_id" TEXT,
    "failure_reason" TEXT,
    "response" JSONB,
    "history" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "managed_agent_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "managed_agent_warm_task" (
    "warm_task_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "task_arn" TEXT,
    "sandbox_url" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),

    CONSTRAINT "managed_agent_warm_task_pkey" PRIMARY KEY ("warm_task_id")
);

-- CreateTable
CREATE TABLE "managed_agent_memory" (
    "memory_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tags" TEXT[],
    "type" TEXT NOT NULL DEFAULT 'convention',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "times_applied" INTEGER NOT NULL DEFAULT 0,
    "last_applied_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'agent',
    "source_user_id" TEXT,
    "source_session_id" TEXT,
    "source_thread_ts" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_agent_memory_pkey" PRIMARY KEY ("memory_id")
);

-- CreateTable
CREATE TABLE "integration_install" (
    "install_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "workspace_name" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "integration_install_pkey" PRIMARY KEY ("install_id")
);

-- CreateTable
CREATE TABLE "agent_integration_binding" (
    "binding_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "install_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_integration_binding_pkey" PRIMARY KEY ("binding_id")
);

-- CreateTable
CREATE TABLE "skill" (
    "skill_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pkey" PRIMARY KEY ("skill_id")
);

-- CreateTable
CREATE TABLE "integration_session" (
    "external_session_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "external_ref" TEXT,
    "last_status" TEXT,
    "last_pr_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_session_pkey" PRIMARY KEY ("external_session_id")
);

-- CreateIndex
CREATE INDEX "managed_agent_created_by_idx" ON "managed_agent"("created_by");

-- CreateIndex
CREATE INDEX "managed_agent_session_agent_id_idx" ON "managed_agent_session"("agent_id");

-- CreateIndex
CREATE INDEX "managed_agent_session_status_idx" ON "managed_agent_session"("status");

-- CreateIndex
CREATE INDEX "managed_agent_session_last_seen_at_idx" ON "managed_agent_session"("last_seen_at");

-- CreateIndex
CREATE INDEX "managed_agent_warm_task_agent_id_status_ready_at_idx" ON "managed_agent_warm_task"("agent_id", "status", "ready_at");

-- CreateIndex
CREATE INDEX "managed_agent_warm_task_status_created_at_idx" ON "managed_agent_warm_task"("status", "created_at");

-- CreateIndex
CREATE INDEX "managed_agent_memory_agent_id_disabled_priority_idx" ON "managed_agent_memory"("agent_id", "disabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "integration_install_integration_id_workspace_id_key" ON "integration_install"("integration_id", "workspace_id");

-- CreateIndex
CREATE INDEX "agent_integration_binding_install_id_idx" ON "agent_integration_binding"("install_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_integration_binding_agent_id_install_id_key" ON "agent_integration_binding"("agent_id", "install_id");

-- CreateIndex
CREATE INDEX "skill_created_by_idx" ON "skill"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "integration_session_session_id_key" ON "integration_session"("session_id");

-- CreateIndex
CREATE INDEX "integration_session_binding_id_idx" ON "integration_session"("binding_id");

-- AddForeignKey
ALTER TABLE "managed_agent_session" ADD CONSTRAINT "managed_agent_session_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_agent_warm_task" ADD CONSTRAINT "managed_agent_warm_task_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_agent_memory" ADD CONSTRAINT "managed_agent_memory_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_integration_binding" ADD CONSTRAINT "agent_integration_binding_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_integration_binding" ADD CONSTRAINT "agent_integration_binding_install_id_fkey" FOREIGN KEY ("install_id") REFERENCES "integration_install"("install_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_session" ADD CONSTRAINT "integration_session_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "managed_agent_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_session" ADD CONSTRAINT "integration_session_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "agent_integration_binding"("binding_id") ON DELETE CASCADE ON UPDATE CASCADE;

