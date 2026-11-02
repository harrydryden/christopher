ALTER TABLE "cv_application_contexts" ADD COLUMN IF NOT EXISTS "refinements_version" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "refinement_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "refined_result_key" text;--> statement-breakpoint
ALTER TABLE "cv_auto_baselines" ADD COLUMN IF NOT EXISTS "input_snapshot" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_drafts_refined_result_idx" ON "cv_drafts" ("user_id", "context_id", "refined_result_key") WHERE "refined_result_key" IS NOT NULL;
