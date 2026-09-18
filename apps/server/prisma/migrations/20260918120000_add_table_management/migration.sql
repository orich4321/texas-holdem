-- Durable host management state. Changes are scheduled while a hand is live
-- and consumed atomically before the next deal.
ALTER TABLE "Room" ADD COLUMN "nextHandIsFinal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Player" ADD COLUMN "leaveAfterHand" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GameEvent" ADD COLUMN "clientActionId" TEXT;

CREATE UNIQUE INDEX "GameEvent_clientActionId_key" ON "GameEvent"("clientActionId");

CREATE TABLE "ChipAdjustment" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "authorizedByPlayerId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stackBefore" INTEGER,
    "stackAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "ChipAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChipAdjustment_roomId_status_idx" ON "ChipAdjustment"("roomId", "status");
CREATE INDEX "ChipAdjustment_playerId_status_idx" ON "ChipAdjustment"("playerId", "status");

ALTER TABLE "ChipAdjustment" ADD CONSTRAINT "ChipAdjustment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChipAdjustment" ADD CONSTRAINT "ChipAdjustment_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChipAdjustment" ADD CONSTRAINT "ChipAdjustment_authorizedByPlayerId_fkey" FOREIGN KEY ("authorizedByPlayerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
