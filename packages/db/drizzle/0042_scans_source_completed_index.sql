-- The status strip shows when a company an account follows was last scanned: the newest finish of a
-- completed, unfailed scan across the sources it follows. Read per source, each answer is the last
-- entry of this index. Without it the planner walked `scans_started_idx` backwards filtering on the
-- source, which for a source with no recent scan reads every retained scan of the catalogue; the
-- query it replaced joined all of them on every render (3 ms at 7,560 scans, growing daily).
--
-- Not CONCURRENTLY, for the reason 0036 gives: the migrator runs every pending file in one
-- transaction. On a production table large enough for the build to matter, build it by hand first
-- with CONCURRENTLY and the same name; IF NOT EXISTS then skips it here.
CREATE INDEX IF NOT EXISTS "scans_source_completed_idx" ON "scans" USING btree ("source_id", "finished_at") WHERE "finished_at" IS NOT NULL AND "status" <> 'failed';
