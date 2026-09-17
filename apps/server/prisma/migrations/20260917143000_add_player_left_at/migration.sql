-- A departed player remains in the auditable final standings, but is excluded
-- from every subsequent hand and its opaque session can no longer authenticate.
ALTER TABLE "Player" ADD COLUMN "leftAt" TIMESTAMP(3);
CREATE INDEX "Player_roomId_leftAt_idx" ON "Player"("roomId", "leftAt");
