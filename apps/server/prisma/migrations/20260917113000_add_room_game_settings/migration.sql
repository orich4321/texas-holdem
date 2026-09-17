-- Durable host-selected configuration for a private table. Defaults preserve
-- every already-created room and make the migration safe to apply in place.
ALTER TABLE "Room"
  ADD COLUMN "initialStack" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "smallBlind" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "bigBlind" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "maxPlayers" INTEGER NOT NULL DEFAULT 9;
