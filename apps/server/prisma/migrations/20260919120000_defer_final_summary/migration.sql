-- Existing completed rooms keep their visible summaries. Newly completed
-- final hands explicitly defer the summary until the host releases it.
ALTER TABLE "Room" ADD COLUMN "finalSummaryVisible" BOOLEAN NOT NULL DEFAULT true;
