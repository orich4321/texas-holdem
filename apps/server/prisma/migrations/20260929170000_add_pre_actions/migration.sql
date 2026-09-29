CREATE TABLE "PreAction" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "playerId" UUID NOT NULL,
  "handStartSequence" INTEGER NOT NULL,
  "street" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "expectedCurrentBet" INTEGER,
  "quotedToCall" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreAction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PreAction_roomId_playerId_key" ON "PreAction"("roomId", "playerId");
CREATE INDEX "PreAction_roomId_idx" ON "PreAction"("roomId");
ALTER TABLE "PreAction" ADD CONSTRAINT "PreAction_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreAction" ADD CONSTRAINT "PreAction_roomId_playerId_fkey" FOREIGN KEY ("roomId", "playerId") REFERENCES "Player"("roomId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
