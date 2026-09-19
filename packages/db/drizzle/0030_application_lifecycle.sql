-- One lifecycle for a company-role, from one account's point of view.
--
-- A role's progress used to be spread across four tables with nothing tying them together:
-- `user_jobs` held the gate result and the archive marker, `decisions` the apply/skip, `cv_drafts`
-- the CV built for it, and `applications` the submitted PDF — and an application knew only which
-- CV revision it came from. So the roles table could not say that a role had reached an interview,
-- and the applications list could not say which posting it was about. `applications.job_id` is
-- that missing link: the shared posting the application is for, which with `user_jobs` and
-- `decisions` makes the eight stages (matched, shortlisted, applying, applied, in process,
-- accepted, rejected, dismissed) readable in one expression. It is nullable and cleared rather
-- than cascaded, because an application record outlives the posting it was made against, and
-- `applications_user_job_idx` is what makes the per-account join cheap.
--
-- The backfill reads the link off the CV each existing row was submitted from, which is where the
-- job was already recorded. Rows whose CV was deleted, or whose CV never carried a job, keep a
-- null `job_id`: they stay in the applications table and simply show no role beside them.
--
-- `pdf_base64` becomes nullable because a stage set from the roles table — "I applied on their
-- site" — has no submitted PDF to store. Every row that has one keeps it.
--
-- `status` stays `text`; the drizzle column now carries the enum, and "applying" joins the list as
-- the stage before anything is submitted.
--
-- Idempotent throughout.

ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "pdf_base64" DROP NOT NULL;--> statement-breakpoint
UPDATE "applications" a SET "job_id" = c."job_id"
  FROM "cv_drafts" c
  WHERE a."cv_id" = c."id" AND a."job_id" IS NULL AND c."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_user_job_idx" ON "applications" USING btree ("user_id","job_id");
