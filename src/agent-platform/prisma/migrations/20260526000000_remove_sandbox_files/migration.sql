-- Remove sandbox_files column from managed_agent table.
-- The setup.sh feature caused every sandbox provision to timeout;
-- skills cover any legitimate "seed files into harness" need.
ALTER TABLE "managed_agent" DROP COLUMN IF EXISTS "sandbox_files";
