ALTER TABLE "Account" ADD COLUMN "username" TEXT;
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

CREATE TABLE "FriendRequest" (
    "id" UUID NOT NULL,
    "fromAccountId" UUID NOT NULL,
    "toAccountId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FriendRequest_fromAccountId_toAccountId_key" ON "FriendRequest"("fromAccountId", "toAccountId");
CREATE INDEX "FriendRequest_toAccountId_idx" ON "FriendRequest"("toAccountId");
ALTER TABLE "FriendRequest" ADD CONSTRAINT "FriendRequest_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FriendRequest" ADD CONSTRAINT "FriendRequest_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Friend" (
    "id" UUID NOT NULL,
    "accountAId" UUID NOT NULL,
    "accountBId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Friend_accountAId_accountBId_key" ON "Friend"("accountAId", "accountBId");
CREATE INDEX "Friend_accountBId_idx" ON "Friend"("accountBId");
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_accountAId_fkey" FOREIGN KEY ("accountAId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_accountBId_fkey" FOREIGN KEY ("accountBId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GameInvite" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "fromAccountId" UUID NOT NULL,
    "toAccountId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GameInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GameInvite_roomId_toAccountId_key" ON "GameInvite"("roomId", "toAccountId");
CREATE INDEX "GameInvite_toAccountId_status_idx" ON "GameInvite"("toAccountId", "status");
ALTER TABLE "GameInvite" ADD CONSTRAINT "GameInvite_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameInvite" ADD CONSTRAINT "GameInvite_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameInvite" ADD CONSTRAINT "GameInvite_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
