-- AlterTable
ALTER TABLE "managed_agent_issue" ADD COLUMN "times_seen" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "managed_agent_issue_comment" (
    "comment_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "session_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_agent_issue_comment_pkey" PRIMARY KEY ("comment_id")
);

-- CreateIndex
CREATE INDEX "managed_agent_issue_comment_issue_id_created_at_idx" ON "managed_agent_issue_comment"("issue_id", "created_at");

-- AddForeignKey
ALTER TABLE "managed_agent_issue_comment" ADD CONSTRAINT "managed_agent_issue_comment_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "managed_agent_issue"("issue_id") ON DELETE CASCADE ON UPDATE CASCADE;
