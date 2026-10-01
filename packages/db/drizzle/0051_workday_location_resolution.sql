-- A Workday listing can report a count instead of naming the role's places.
ALTER TABLE "jobs"
  ADD COLUMN "location_resolution" text,
  ADD COLUMN "location_label" text,
  ADD COLUMN "location_revision" text,
  ADD COLUMN "location_fetched_at" timestamptz,
  ADD COLUMN "location_error" text;

-- Older scans placed this count in location, where a geographic gate treated it as a place.
-- The old observation has no revision; a later listing scan or gate walk supplies one.
UPDATE "jobs" AS j
SET "location_resolution" = 'pending', "location_label" = j."location", "location" = NULL,
    "locations" = '[]'::jsonb
FROM "career_sources" AS s
WHERE j."source_id" = s."id" AND s."type" = 'workday'
  AND j."location" ~* '^[1-9][0-9]* Locations$';
