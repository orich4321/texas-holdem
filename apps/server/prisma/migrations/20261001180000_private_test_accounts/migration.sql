ALTER TABLE "Account" ADD COLUMN "directoryVisibleToAccountId" UUID;
CREATE INDEX "Account_directoryVisibleToAccountId_idx" ON "Account"("directoryVisibleToAccountId");

-- These are existing development accounts. Keep them available in the
-- authenticated owner's directory, but omit them from everyone else's.
UPDATE "Account" AS test_account
SET "directoryVisibleToAccountId" = owner.id
FROM "Account" AS owner
WHERE owner.username = 'orich4321'
  AND (
    (test_account.username = 'orich4320' AND test_account."displayName" = 'טסט')
    OR (test_account.username = 'orich4322' AND test_account."displayName" = 'בדיקה')
  );
