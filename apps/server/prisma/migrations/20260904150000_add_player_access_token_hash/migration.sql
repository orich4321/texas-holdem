-- AlterTable
ALTER TABLE "Player" ADD COLUMN "accessTokenHash" TEXT;

-- Backfill
-- Existing seats receive an unguessable replacement credential hash. Their prior
-- credential state is deliberately invalidated because no plaintext token exists to hash.
UPDATE "Player"
SET "accessTokenHash" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "accessTokenHash" IS NULL;

-- AlterTable
ALTER TABLE "Player" ALTER COLUMN "accessTokenHash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Player_accessTokenHash_key" ON "Player"("accessTokenHash");
