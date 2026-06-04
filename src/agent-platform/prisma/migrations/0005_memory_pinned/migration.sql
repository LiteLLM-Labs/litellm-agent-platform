-- AlterTable
ALTER TABLE "managed_agent_memory" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "managed_agent" ADD COLUMN "preload_memory_limit" INTEGER NOT NULL DEFAULT 10;

-- CreateIndex
CREATE INDEX "Memory_agent_pinned_idx" ON "managed_agent_memory"("agent_id", "pinned");
