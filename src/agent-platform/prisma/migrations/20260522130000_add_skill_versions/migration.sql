CREATE TABLE "skill_version" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "changed_by_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_version_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "skill_version_skill_id_version_number_idx" ON "skill_version"("skill_id", "version_number");

ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill"("skill_id") ON DELETE CASCADE ON UPDATE CASCADE;
