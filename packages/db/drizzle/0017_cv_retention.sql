-- Application PDFs and company/role snapshots survive source-CV deletion.
ALTER TABLE "applications" DROP CONSTRAINT "applications_cv_id_cv_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "cv_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_cv_id_cv_drafts_id_fk" FOREIGN KEY ("cv_id") REFERENCES "public"."cv_drafts"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Preserve the user's current choice; only demote duplicate current ready drafts.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))),
                 lower(btrim(regexp_replace(job_title, '[[:space:]]+', ' ', 'g')))
    ORDER BY created_at DESC, id DESC
  ) AS position FROM cv_drafts WHERE archived_at IS NULL AND status = 'ready'
)
UPDATE cv_drafts SET archived_at = created_at FROM ranked WHERE cv_drafts.id = ranked.id AND ranked.position > 1;
--> statement-breakpoint
-- Retain the most recently archived CV, including explicit manual archive choices.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))),
                 lower(btrim(regexp_replace(job_title, '[[:space:]]+', ' ', 'g')))
    ORDER BY archived_at DESC, created_at DESC, id DESC
  ) AS position FROM cv_drafts WHERE archived_at IS NOT NULL
)
DELETE FROM cv_drafts USING ranked WHERE cv_drafts.id = ranked.id AND ranked.position > 1;
