-- The Operations page's cost-per-build sample groups the CV calls of the last ninety days by the
-- draft they were for. Without this the grouping walks every row of the ledger with a CV ref type.
--
-- Not CONCURRENTLY, for the reason 0036 gives: the migrator runs every pending file in one
-- transaction. On a production table large enough for the build to matter, build it by hand first
-- with CONCURRENTLY and the same name; IF NOT EXISTS then skips it here.
CREATE INDEX IF NOT EXISTS "ai_calls_cv_ref_at_idx" ON "ai_calls" USING btree ("ref_id", "at") WHERE "ref_type" like 'cv-%' AND "ref_id" IS NOT NULL;
