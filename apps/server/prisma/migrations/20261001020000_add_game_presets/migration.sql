CREATE TABLE "GamePreset" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "initialStack" INTEGER NOT NULL,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GamePreset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GamePreset_accountId_name_key" ON "GamePreset"("accountId", "name");
CREATE INDEX "GamePreset_accountId_idx" ON "GamePreset"("accountId");
ALTER TABLE "GamePreset" ADD CONSTRAINT "GamePreset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
