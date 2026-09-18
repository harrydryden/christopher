-- Worker observability: an event ledger for the process itself, plus two columns that let the
-- interface tell "slow" from "stopped".
--
-- `worker_events` records boots (with the heap ceiling the process found), crash recoveries (with
-- the tasks that were running when the previous process died, so a task that keeps killing the
-- worker is named rather than inferred), tasks abandoned after their last attempt, and holds
-- released on a worker's behalf. Operations reads it; a thirty-day sweep prunes it.
--
-- `cv_drafts.progress_at` is bumped every time a build advances. A draft still `generating` whose
-- progress is old is a build the worker stopped, which the CV page can now say instead of
-- spinning. `scans.fetched_bytes` records how large the listing was, so the largest inputs the
-- worker holds in memory are visible before they become the reason it crashes.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "worker_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "worker_id" text NOT NULL,
  "kind" text NOT NULL,
  "task_id" uuid,
  "task_type" text,
  "user_id" uuid,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_events_at_idx" ON "worker_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_events_kind_at_idx" ON "worker_events" USING btree ("kind","at");--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "fetched_bytes" integer;
