ALTER TABLE "Player" ALTER COLUMN "currentStack" TYPE DOUBLE PRECISION;
ALTER TABLE "Player" ADD COLUMN "seatOrder" INTEGER NOT NULL DEFAULT 0;
-- Keep the original dealt seating order for existing games, then append late joiners.
WITH first_hands AS (
  SELECT DISTINCT ON ("roomId") "roomId", "state"->'snapshot'->'hand'->'seats' AS seats
  FROM "GameSnapshot" ORDER BY "roomId", "sequence"
), ranked AS (
  SELECT p."id", ROW_NUMBER() OVER (PARTITION BY p."roomId" ORDER BY
    COALESCE((SELECT (s->>'seatNumber')::integer FROM jsonb_array_elements(f.seats) s WHERE s->>'playerId' = p."id"::text LIMIT 1),
      CASE WHEN f.seats IS NULL AND p."id" = r."hostPlayerId" THEN 0 ELSE 2147483647 END),
    p."createdAt", p."id") - 1 AS ordinal
  FROM "Player" p JOIN "Room" r ON r."id" = p."roomId"
  LEFT JOIN first_hands f ON f."roomId" = p."roomId"
)
UPDATE "Player" p SET "seatOrder" = ranked.ordinal FROM ranked WHERE p."id" = ranked."id";
ALTER TABLE "ChipAdjustment" ALTER COLUMN "stackBefore" TYPE DOUBLE PRECISION,
  ALTER COLUMN "stackAfter" TYPE DOUBLE PRECISION;

CREATE TABLE "JackpotPool" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "balanceUnits" INTEGER NOT NULL DEFAULT 0 CHECK ("balanceUnits" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "JackpotPool" ("id") VALUES ('seven-deuce-offsuit');

CREATE TABLE "JackpotHand" (
  "roomId" UUID NOT NULL,
  "handSequence" INTEGER NOT NULL,
  "contributions" JSONB NOT NULL,
  "payouts" JSONB NOT NULL,
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("roomId", "handSequence"),
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Financial records are accessible only through the authenticated game server.
ALTER TABLE "JackpotPool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JackpotHand" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "JackpotPool", "JackpotHand" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "JackpotPool", "JackpotHand" FROM authenticated;
  END IF;
END $$;
