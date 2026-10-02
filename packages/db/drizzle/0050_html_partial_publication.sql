-- A continuing HTML scan publishes only pages it has observed and committed.
ALTER TABLE "html_scan_generations"
  ADD COLUMN "published_page_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "published_new_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "seed_first_scan" boolean;

-- Old-worker page inserts during a rolling deploy must remain conservatively old.
-- Existing staged pages have a useful generation timestamp; migration time would
-- falsely make stale evidence newer than a completed scan.
ALTER TABLE "html_scan_pages"
  ADD COLUMN "observed_at" timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00'::timestamptz;
UPDATE "html_scan_pages" AS p SET "observed_at" = g."started_at"
  FROM "html_scan_generations" AS g WHERE p."generation_id" = g."id";
