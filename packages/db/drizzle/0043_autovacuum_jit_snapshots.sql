-- Per-table autovacuum for the tables that churn, an index for snapshot retention, and no JIT
-- compilation for this database.
--
-- `tasks` is a queue: every claim and every finish rewrites its indexed `status`, so until vacuum
-- runs the old versions stay in the index range the claim reads. At the default scale factor of 0.2
-- on about 60,000 retained rows, vacuum waited for about 12,000 dead tuples, roughly three days of
-- churn at a thousand companies; a scan-lane claim read 88 buffers clean, 277 after 8,008 dead
-- tuples and 92 after VACUUM. `job_events`, `scans` and `ai_calls` are mostly inserts, pruned
-- hourly: the insert threshold keeps their visibility maps current for the retention statements and
-- index-only scans. `user_jobs` is rewritten on every rescore and gate re-evaluation.
--
-- `ALTER TABLE ... SET (...)` takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.
-- Revert a table with `ALTER TABLE <t> RESET (<parameter>, ...)`.
ALTER TABLE "tasks" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 500,
                         autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500);--> statement-breakpoint
ALTER TABLE "job_events" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02,
                              autovacuum_vacuum_insert_scale_factor = 0.05);--> statement-breakpoint
ALTER TABLE "scans" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02,
                         autovacuum_vacuum_insert_scale_factor = 0.05);--> statement-breakpoint
ALTER TABLE "ai_calls" SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);--> statement-breakpoint
ALTER TABLE "user_jobs" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);--> statement-breakpoint
-- The scans that still hold a compressed snapshot: a handful per source, since each scan clears all
-- but its source's last few. The hourly snapshot retention (apps/worker/src/maintenance.ts) finds its
-- candidates and each source's newest kept snapshot here, instead of walking every retained scan.
-- At 125,000 scans on 1,000 sources (median of five): 109 ms instead of 622 ms to clear 2,380
-- snapshots, and 0.6 ms instead of 35-340 ms for an hour with nothing to clear. Not CONCURRENTLY,
-- for the reason 0036 gives; on a large table build it by hand first with CONCURRENTLY and the same
-- name.
CREATE INDEX IF NOT EXISTS "scans_snapshot_idx" ON "scans" USING btree ("source_id", "started_at") WHERE "raw_snapshot" IS NOT NULL;--> statement-breakpoint
-- JIT off for every new session on this database. No captured plan crosses `jit_above_cost` today
-- (the largest is about a tenth of it), but a catalogue-wide admin or export query at scale would,
-- and would then spend 50-200 ms compiling a query that runs in a fraction of that. It changes only
-- sessions opened afterwards, which with pooled and idle-timed connections is within minutes.
--
-- Only the database's owner (or a superuser) may set it. A migration run by a role that is neither
-- skips it with a notice rather than failing every other migration in the same transaction; set it
-- by hand then, as the owner: ALTER DATABASE <name> SET jit = off. Revert with RESET jit.
-- Do not add `idle_session_timeout` here: it would end PgBouncer's idle server connections.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET jit = off', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'jit left as it is: % does not own database %; run ALTER DATABASE % SET jit = off as its owner', current_user, current_database(), current_database();
END
$$;
