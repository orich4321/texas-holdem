CREATE TABLE "CoachReport" (
  "id" UUID PRIMARY KEY, "roomId" UUID NOT NULL REFERENCES "Room"("id") ON DELETE CASCADE,
  "playerId" UUID NOT NULL REFERENCES "Player"("id") ON DELETE CASCADE,
  "accountId" UUID NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "model" TEXT NOT NULL, "engineVersion" TEXT NOT NULL,
  "totalHands" INTEGER NOT NULL DEFAULT 0, "completedHands" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID, "leaseUntil" TIMESTAMP(3), "errorCode" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0, "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "overallScore" INTEGER, "manifest" JSONB NOT NULL, "identity" JSONB NOT NULL, "report" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
  CONSTRAINT "CoachReport_status_check" CHECK ("status" IN ('PENDING','PROCESSING','COMPLETED','FAILED','RATE_LIMITED')),
  CONSTRAINT "CoachReport_score_check" CHECK ("overallScore" BETWEEN 0 AND 100),
  CONSTRAINT "CoachReport_roomId_playerId_key" UNIQUE ("roomId", "playerId")
);
CREATE INDEX "CoachReport_accountId_roomId_idx" ON "CoachReport"("accountId", "roomId");
CREATE INDEX "CoachReport_playerId_idx" ON "CoachReport"("playerId");
CREATE INDEX "CoachReport_status_nextAttemptAt_idx" ON "CoachReport"("status", "nextAttemptAt");
CREATE TABLE "CoachHand" (
  "reportId" UUID NOT NULL REFERENCES "CoachReport"("id") ON DELETE CASCADE,
  "handKey" TEXT NOT NULL, "number" INTEGER NOT NULL, "complete" BOOLEAN NOT NULL DEFAULT false, "data" JSONB NOT NULL,
  PRIMARY KEY ("reportId", "handKey")
);
CREATE TABLE "CoachQuota" (
  "id" TEXT PRIMARY KEY, "nextRequestAt" TIMESTAMP(3) NOT NULL, "day" TEXT NOT NULL,
  "dailyCalls" INTEGER NOT NULL DEFAULT 0, "month" TEXT NOT NULL, "monthlyCalls" INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE "CoachReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachHand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachQuota" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "CoachPublicHand" (
  "roomId" UUID NOT NULL REFERENCES "Room"("id") ON DELETE CASCADE,
  "handKey" TEXT NOT NULL, "data" JSONB NOT NULL, PRIMARY KEY ("roomId", "handKey")
);
ALTER TABLE "CoachPublicHand" ENABLE ROW LEVEL SECURITY;
-- Authentication is performed with our opaque server sessions, not client JWT
-- claims. No direct Data API access is allowed, including to job metadata.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "CoachReport", "CoachHand", "CoachQuota", "CoachPublicHand" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "CoachReport", "CoachHand", "CoachQuota", "CoachPublicHand" FROM authenticated;
  END IF;
END $$;
