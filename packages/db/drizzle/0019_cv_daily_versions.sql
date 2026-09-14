CREATE TABLE "cv_versions" (
	"cv_id" uuid PRIMARY KEY NOT NULL,
	"role_key" text NOT NULL,
	"day" text NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cv_versions_role_day_version_idx" ON "cv_versions" USING btree ("role_key","day","version");
--> statement-breakpoint
LOCK TABLE cv_drafts IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Backfill the surviving historical CVs in creation order. Previously deleted
-- CVs cannot be reconstructed; future allocations remain after deletion.
INSERT INTO cv_versions (cv_id, role_key, day, version)
SELECT id, role_key, day, row_number() OVER (PARTITION BY role_key, day ORDER BY created_at, id)::integer
FROM (
  SELECT id, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
    length(lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))))::text || ':' ||
    lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))) ||
    lower(btrim(regexp_replace(job_title, '[[:space:]]+', ' ', 'g'))) AS role_key
  FROM cv_drafts
) drafts;
--> statement-breakpoint
CREATE FUNCTION allocate_cv_daily_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  role_key_value text;
  day_value text;
BEGIN
  role_key_value := length(lower(btrim(regexp_replace(NEW.company_name, '[[:space:]]+', ' ', 'g'))))::text || ':' ||
    lower(btrim(regexp_replace(NEW.company_name, '[[:space:]]+', ' ', 'g'))) ||
    lower(btrim(regexp_replace(NEW.job_title, '[[:space:]]+', ' ', 'g')));
  day_value := to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  PERFORM pg_advisory_xact_lock(hashtextextended(role_key_value, 0));
  INSERT INTO cv_versions (cv_id, role_key, day, version)
    SELECT NEW.id, role_key_value, day_value, coalesce(max(version), 0) + 1
    FROM cv_versions WHERE role_key = role_key_value AND day = day_value;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cv_daily_version AFTER INSERT ON cv_drafts
FOR EACH ROW EXECUTE FUNCTION allocate_cv_daily_version();
