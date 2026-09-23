-- What the scan and the gate record about closure, and about each account's view of a posting.
--
-- `jobs.first_missed_at` is when an open posting was first found missing from a successful scan:
-- set as its miss count goes from 0 to 1, cleared whenever a scan lists it. Two misses close a role
-- only when they are independent evidence, so the closing miss must come at least six hours after
-- the first (`MIN_CLOSE_SEPARATION_MS` in @ava/core); a rescan minutes after the daily scan, or a
-- retried task, is the same observation made twice. An open posting that is already missed once is
-- stamped with the migration's own time, which can only delay its closure, never hasten it.
--
-- `jobs.shared` is false for a posting a follower pasted from a host that is not the company's (not
-- its domain, not its careers source's host, not its own board on an applicant-tracking vendor). It
-- is kept for the account that pasted it and is never offered to any other follower's gate.
--
-- `user_jobs.gate_archived_at` is when the gate put the view away. While `archived_at` still equals
-- it the archive is the gate's own, and the view comes back as soon as the gate admits it again; an
-- archive a person made, or one made after a person restored the view, never matches. Backfilled
-- from the gate's own archive events, which carry the same transaction timestamp.
--
-- `user_jobs.added_by_url` marks a view the account asked for by pasting the posting's URL, whether
-- that paste created the posting or found it already in the catalogue. The gate treats it like a
-- decision: the view stays in that account's table whatever its keywords say. Backfilled from
-- `jobs.added_by`, which can only name the first account that pasted it.
--
-- `user_jobs.scored_at` is when the last scoring of the view completed. Beside a null fit score it
-- means the model was asked and gave no usable answer, so a scan does not queue the view again
-- every day for the same inputs.
--
-- Idempotent throughout.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "first_missed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "jobs" SET "first_missed_at" = now() WHERE "status" = 'open' AND "missing_scans" > 0 AND "first_missed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "shared" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "gate_archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "user_jobs" uj SET "gate_archived_at" = uj."archived_at"
  WHERE uj."archived_at" IS NOT NULL AND uj."gate_archived_at" IS NULL
    AND EXISTS (SELECT 1 FROM "job_events" e WHERE e."job_id" = uj."job_id" AND e."user_id" = uj."user_id"
      AND e."type" = 'updated' AND e."payload"->>'action' = 'archived' AND e."payload"->>'actor' = 'system' AND e."at" = uj."archived_at");--> statement-breakpoint
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "added_by_url" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "user_jobs" uj SET "added_by_url" = true FROM "jobs" j
  WHERE j."id" = uj."job_id" AND j."added_by" = uj."user_id" AND uj."added_by_url" = false;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "scored_at" timestamp with time zone;
