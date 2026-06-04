-- CreateTable: append-only durable conversation log for session recovery
CREATE TABLE "managed_agent_session_message" (
  "message_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "session_id" TEXT NOT NULL,
  "harness_session_id" TEXT,
  "seq" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "parts" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "managed_agent_session_message_pkey" PRIMARY KEY ("message_id")
);

CREATE UNIQUE INDEX "managed_agent_session_message_session_id_seq_key" ON "managed_agent_session_message"("session_id", "seq");

CREATE INDEX "managed_agent_session_message_session_id_created_at_idx" ON "managed_agent_session_message"("session_id", "created_at");

ALTER TABLE "managed_agent_session_message"
  ADD CONSTRAINT "managed_agent_session_message_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "managed_agent_session"("session_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
