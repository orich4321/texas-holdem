CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "supabaseUserId" UUID NOT NULL,
    "displayName" TEXT,
    "avatarDataUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Account_supabaseUserId_key" ON "Account"("supabaseUserId");

CREATE TABLE "AccountSession" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountSession_tokenHash_key" ON "AccountSession"("tokenHash");
CREATE INDEX "AccountSession_accountId_idx" ON "AccountSession"("accountId");
CREATE INDEX "AccountSession_expiresAt_idx" ON "AccountSession"("expiresAt");
ALTER TABLE "AccountSession" ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Player" ADD COLUMN "accountId" UUID;
CREATE UNIQUE INDEX "Player_roomId_accountId_key" ON "Player"("roomId", "accountId");
ALTER TABLE "Player" ADD CONSTRAINT "Player_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
