-- `settings` goes back to being the system-settings table.
--
-- It is read whole, with no WHERE, on the worker's hottest paths: every AI call and every robots
-- check reads the system settings, and every follower of every company reads them again on each
-- scan. Two families of internal bookkeeping had been growing inside it without bound — one row
-- per (account, role) ever scored, and one row per careers source holding up to 10,000
-- fingerprints — so each of those reads was shipping the whole pile.
--
-- Both move to where they belong. The scoring fingerprint is a property of one account's view of
-- one role, so it becomes a column on `user_jobs`. The rejected-detail fingerprints are a property
-- of a careers source, so they get a table keyed by the source, which also means deleting a source
-- takes its cache with it instead of leaving an orphan row behind.
--
-- The values are carried across before the old rows are deleted: without the backfill, the first
-- scan after deploy would re-score every role in every table and re-fetch every rejected detail
-- page — a large, avoidable model and fetch bill. A legacy fingerprint was written as a JSON
-- string, so it is unwrapped with `#>> '{}'` rather than cast, which would keep the quotes.
--
-- Idempotent: the column and table are created only if absent, the backfills skip rows already
-- carrying a value, and a second run finds no legacy keys left to move.

ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "score_input_hash" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_admission_rejections" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"fingerprints" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_admission_rejections_source_id_career_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."career_sources"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint

-- What each stored score was computed from, onto the account's own view of the role.
UPDATE "user_jobs" uj SET "score_input_hash" = s."value" #>> '{}'
FROM "settings" s
WHERE s."key" = 'internal:scoreInput:' || uj."user_id"::text || ':' || uj."job_id"::text
  AND jsonb_typeof(s."value") = 'string'
  AND uj."score_input_hash" IS NULL;--> statement-breakpoint

-- The rejected-detail cache, one row per source. A row whose source is gone is simply dropped.
INSERT INTO "source_admission_rejections" ("source_id", "fingerprints")
SELECT cs."id", s."value"
FROM "settings" s
JOIN "career_sources" cs ON s."key" = 'internal:rejections:' || cs."id"::text
WHERE jsonb_typeof(s."value") = 'object'
ON CONFLICT ("source_id") DO NOTHING;--> statement-breakpoint

DELETE FROM "settings" WHERE "key" LIKE 'internal:scoreInput:%' OR "key" LIKE 'internal:rejections:%';
