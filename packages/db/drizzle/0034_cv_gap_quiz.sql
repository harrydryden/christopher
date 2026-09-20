-- The build can pause after role analysis for up to four optional factual questions. The payload
-- stays with the draft so retries and duplicate submissions see the same questions and outcome.
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "gap_quiz" jsonb;
