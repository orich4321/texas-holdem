-- A request belongs to the existing seat; no new identity or chips are created.
ALTER TABLE "Player" ADD COLUMN "rejoinRequestedAt" TIMESTAMP(3);
