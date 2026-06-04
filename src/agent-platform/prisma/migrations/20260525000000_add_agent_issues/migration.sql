-- CreateTable
CREATE TABLE "managed_agent_issue" (
    "issue_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_agent_issue_pkey" PRIMARY KEY ("issue_id")
);

-- CreateIndex
CREATE INDEX "managed_agent_issue_agent_id_status_created_at_idx" ON "managed_agent_issue"("agent_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "managed_agent_issue" ADD CONSTRAINT "managed_agent_issue_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "managed_agent"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;
