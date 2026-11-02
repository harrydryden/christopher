CREATE TABLE IF NOT EXISTS "cv_application_contexts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
  "request_key" text NOT NULL,
  "job_title" text NOT NULL,
  "company_name" text NOT NULL,
  "current_description_version_id" uuid,
  "selected_kind" text,
  "selected_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_application_contexts_user_request_idx" ON "cv_application_contexts" ("user_id", "request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_application_contexts_user_idx" ON "cv_application_contexts" ("user_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_context_descriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "context_id" uuid NOT NULL REFERENCES "cv_application_contexts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "text" text NOT NULL,
  "source" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_context_descriptions_version_idx" ON "cv_context_descriptions" ("context_id", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_context_descriptions_user_idx" ON "cv_context_descriptions" ("user_id", "context_id");--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "context_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "description_version_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "editing_mode" text;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "auto_baseline_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "editing_targets" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "applied_refinements" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_drafts_context_idx" ON "cv_drafts" ("user_id", "context_id", "created_at") WHERE "context_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_auto_baselines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "context_id" uuid NOT NULL REFERENCES "cv_application_contexts"("id") ON DELETE CASCADE,
  "description_version_id" uuid NOT NULL REFERENCES "cv_context_descriptions"("id"),
  "input_key" text NOT NULL,
  "input_snapshot" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "source_draft_id" uuid,
  "content" jsonb,
  "assessment" jsonb,
  "library_snapshot" jsonb,
  "editing_targets" jsonb,
  "engine_contract" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "published_at" timestamp with time zone,
  CONSTRAINT "cv_auto_baselines_status_check" CHECK ("status" IN ('queued','ready','failed')),
  CONSTRAINT "cv_auto_baselines_ready_check" CHECK ("status" <> 'ready' OR
    ("content" IS NOT NULL AND "library_snapshot" IS NOT NULL AND "editing_targets" IS NOT NULL AND "published_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_auto_baselines_input_idx" ON "cv_auto_baselines" ("user_id", "context_id", "input_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_auto_baselines_user_idx" ON "cv_auto_baselines" ("user_id", "context_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_refinement_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "context_id" uuid NOT NULL REFERENCES "cv_application_contexts"("id") ON DELETE CASCADE,
  "stable_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "refinement" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_refinement_events_stable_version_idx" ON "cv_refinement_events" ("context_id", "stable_id", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_refinement_events_user_idx" ON "cv_refinement_events" ("user_id", "context_id", "created_at");--> statement-breakpoint
ALTER TABLE "cv_pdfs" ADD COLUMN IF NOT EXISTS "approval_mode" text;--> statement-breakpoint
ALTER TABLE "cv_pdfs" ADD COLUMN IF NOT EXISTS "approval_hash" text;--> statement-breakpoint
ALTER TABLE "cv_pdfs" ADD COLUMN IF NOT EXISTS "measured_pages" integer;--> statement-breakpoint
ALTER TABLE "cv_pdfs" ADD COLUMN IF NOT EXISTS "acknowledged_warnings" jsonb;
