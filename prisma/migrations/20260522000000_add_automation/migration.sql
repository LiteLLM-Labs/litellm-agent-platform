-- CreateTable: managed_agent_automation
CREATE TABLE "managed_agent_automation" (
    "automation_id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" TEXT NOT NULL,
    "name" TEXT,
    "instruction" TEXT NOT NULL,
    "cron_expr" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ,
    "next_run_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_by" TEXT,

    CONSTRAINT "managed_agent_automation_pkey" PRIMARY KEY ("automation_id")
);

-- AddForeignKey
ALTER TABLE "managed_agent_automation" ADD CONSTRAINT "managed_agent_automation_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex: worker query (due automations)
CREATE INDEX "managed_agent_automation_enabled_next_run_at_idx" ON "managed_agent_automation"("enabled", "next_run_at");

-- CreateIndex: agent page query
CREATE INDEX "managed_agent_automation_agent_id_idx" ON "managed_agent_automation"("agent_id");
