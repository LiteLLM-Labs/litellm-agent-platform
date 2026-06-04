-- CreateTable
CREATE TABLE "managed_agent_automation" (
    "automation_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" TEXT,
    "instruction" TEXT NOT NULL,
    "cron_expr" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "managed_agent_automation_pkey" PRIMARY KEY ("automation_id")
);

-- CreateIndex
CREATE INDEX "managed_agent_automation_enabled_next_run_at_idx" ON "managed_agent_automation"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "managed_agent_automation_agent_id_idx" ON "managed_agent_automation"("agent_id");

-- AddForeignKey
ALTER TABLE "managed_agent_automation" ADD CONSTRAINT "managed_agent_automation_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;
