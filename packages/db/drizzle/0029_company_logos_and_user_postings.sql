-- Company logos captured as bytes, and postings a follower added by URL.
--
-- `company_logos` holds the image itself, one row per company, base64 in a text column for the
-- same reason `applications.pdf_base64` is: one column, no large-object plumbing, and a row that
-- travels with a dump. Until now a company carried only `favicon_url`, a remote address each
-- browser fetched for itself, so a site that serves its icon to a browser and refuses our worker
-- (or the other way round) showed a logo on one page and a blank square on another. The worker
-- captures the bytes once and every page serves the same image. `favicon_url` stays: it records
-- where the capture came from and remains the browser's fallback while nothing is stored.
--
-- `companies.logo_attempts` / `logo_next_attempt_at` / `logo_error` are the retry state, so a
-- site that is down today is tried again on a widening backoff rather than every day forever, and
-- `logo_fetched_at` is what the interface versions the image URL with. `companies.added_by`
-- records the account that put a company in the shared catalogue.
--
-- `jobs.origin` separates a posting a scan observed from one a follower pasted the URL of. Only a
-- successful scan may close a role, and a `user` posting was never in a listing to go missing
-- from, so closure detection must be able to tell them apart; `jobs_company_origin_idx` is what
-- makes that cheap. `jobs.added_by` records whose paste it was.
--
-- `company_name_suggestions` is a follower's proposed name for a company in the shared catalogue —
-- the case where someone adds a company before anyone has confirmed its careers page and the name
-- derived from the domain is wrong. The catalogue is shared, so applying it stays an
-- administrator's move; this table is the proposal, who made it and how it was resolved.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "company_logos" (
  "company_id" uuid PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE,
  "content_type" text NOT NULL,
  "data_base64" text NOT NULL,
  "byte_length" integer NOT NULL,
  "source" text NOT NULL,
  "source_url" text NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_error" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'scan' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_company_origin_idx" ON "jobs" USING btree ("company_id","origin");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_name_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "note" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_name_suggestions_company_status_idx" ON "company_name_suggestions" USING btree ("company_id","status");
