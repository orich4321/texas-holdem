UPDATE "Player" SET "isSittingOut" = true WHERE "currentStack" = 0 AND "leftAt" IS NULL;
