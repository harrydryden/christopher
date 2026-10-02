-- Hourly orphan repair reads only pending score states in oldest-first order. Null timestamps
-- identify legacy rows; current producers always stamp them. The task owner check is separate.
CREATE INDEX IF NOT EXISTS "user_jobs_waiting_score_idx" ON "user_jobs"
  ("score_state_at" ASC NULLS FIRST, "user_id", "job_id")
  WHERE "score_state" IN ('requested', 'queued');
