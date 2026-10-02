CREATE TABLE "AccountHiddenGame" (
    "accountId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountHiddenGame_pkey" PRIMARY KEY ("accountId", "roomId")
);

CREATE INDEX "AccountHiddenGame_accountId_idx" ON "AccountHiddenGame"("accountId");

ALTER TABLE "AccountHiddenGame" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "AccountHiddenGame"
  ADD CONSTRAINT "AccountHiddenGame_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountHiddenGame"
  ADD CONSTRAINT "AccountHiddenGame_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
