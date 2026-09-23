-- Indexes for the lookups and sweeps that read whole tables at a thousand accounts, and a narrower
-- dedupe rule for the task queue.
--
-- Nothing here is CONCURRENTLY: the migrator runs every pending file in one transaction, where
-- PostgreSQL refuses it. A plain build blocks writes to its table while it runs, which takes
-- seconds at today's sizes. On a production table large enough for that to matter, build the index
-- by hand first with CONCURRENTLY and the same name; every statement here is IF NOT EXISTS, so the
-- migration then skips it (packages/db/README.md).
--
-- Deletions. Removing a company deletes its postings, and each deleted posting sets job_id null on
-- the decisions, drafts and applications that pointed at it; deleting a draft (CV retention does
-- it routinely) does the same on applications and removes its share links; deleting an account
-- removes its job events. PostgreSQL finds those rows with one query per deleted row on the
-- referencing column, which without an index leading with that column is a scan of the table.
CREATE INDEX IF NOT EXISTS "decisions_job_idx" ON "decisions" USING btree ("job_id") WHERE "job_id" IS NOT NULL;--> statement-breakpoint
-- Also the per-row "does this account hold a CV for this role" probe, which is equality on both.
CREATE INDEX IF NOT EXISTS "cv_drafts_job_user_idx" ON "cv_drafts" USING btree ("job_id", "user_id") WHERE "job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_job_idx" ON "applications" USING btree ("job_id") WHERE "job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_cv_idx" ON "applications" USING btree ("cv_id") WHERE "cv_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_shares_draft_idx" ON "cv_shares" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_added_by_idx" ON "jobs" USING btree ("added_by") WHERE "added_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_candidates_user_idx" ON "discovery_candidates" USING btree ("user_id");--> statement-breakpoint
-- A posting's recent events are the shared observations plus the reading account's own. Split by
-- whose they are, each half is read from its own index instead of every account's events for the
-- posting; the per-account half also serves account deletion.
CREATE INDEX IF NOT EXISTS "job_events_user_job_at_idx" ON "job_events" USING btree ("user_id", "job_id", "at") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_shared_job_at_idx" ON "job_events" USING btree ("job_id", "at") WHERE "user_id" IS NULL;--> statement-breakpoint
-- Tasks looked up by what their payload is about: a company's scans and discovery, a draft's build,
-- an account's reviews and imports. The predicate is what lets these be small, and an equality on
-- the expression is enough for the planner to prove it.
CREATE INDEX IF NOT EXISTS "tasks_company_idx" ON "tasks" USING btree (("payload"->>'companyId'), "type", "status") WHERE ("payload"->>'companyId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_draft_idx" ON "tasks" USING btree (("payload"->>'draftId'), "status") WHERE ("payload"->>'draftId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_user_idx" ON "tasks" USING btree (("payload"->>'userId'), "type", "created_at") WHERE ("payload"->>'userId') IS NOT NULL;--> statement-breakpoint
-- The roles first seen during one scan of one source, for the scan banner; and scans by date, for
-- Health, Operations and retention.
CREATE INDEX IF NOT EXISTS "jobs_source_first_seen_idx" ON "jobs" USING btree ("source_id", "first_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scans_started_idx" ON "scans" USING btree ("started_at");--> statement-breakpoint
-- The scheduler expires pending suggestions every minute across every account.
CREATE INDEX IF NOT EXISTS "company_suggestions_pending_created_idx" ON "company_suggestions" USING btree ("created_at") WHERE "status" = 'pending';--> statement-breakpoint
-- Retention: every hourly delete walks an index rather than its table. The job_events predicate
-- repeats the prune's type list exactly, so the planner can prove it.
CREATE INDEX IF NOT EXISTS "tasks_status_finished_idx" ON "tasks" USING btree ("status", "finished_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_prunable_at_idx" ON "job_events" USING btree ("at") WHERE "type" IN ('updated', 'scored', 'description_fetched');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_at_idx" ON "login_attempts" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_expires_idx" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_used_idx" ON "auth_tokens" USING btree ("used_at") WHERE "used_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_reservations_expires_idx" ON "ai_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_started_idx" ON "discovery_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_cache_expires_idx" ON "verification_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_documents_processed_idx" ON "discovery_documents" USING btree ("processed_at") WHERE "content" <> '';--> statement-breakpoint
-- Dedupe covers the tasks that are queued and have never started. With running tasks included, an
-- enqueue made while a task ran (a library saved during its review, a description fetched during a
-- score) was dropped, and the run finished on the state it had read; now it leaves one follow-up
-- that reads the state as it is by then. A task that has started keeps `started_at` when a retry,
-- the stale sweep or a shutdown hands it back to the queue, so it never collides with its own
-- follow-up. CV builds keep the rule they had: the draft's lifecycle allows one build at a time,
-- and the interface refuses a rebuild while the previous task is still finishing rather than queue
-- a second one behind it. The plain index keeps "is anything queued or running for this key" an
-- index lookup.
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_dedupe_queued_uidx" ON "tasks" USING btree ("dedupe_key") WHERE "status" = 'queued' AND "started_at" IS NULL AND "type" <> 'generate_cv' AND "dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_dedupe_cv_build_uidx" ON "tasks" USING btree ("dedupe_key") WHERE "type" = 'generate_cv' AND "status" IN ('queued', 'running') AND "dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_dedupe_active_idx" ON "tasks" USING btree ("dedupe_key") WHERE "status" IN ('queued', 'running') AND "dedupe_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_dedupe_active_uidx";
