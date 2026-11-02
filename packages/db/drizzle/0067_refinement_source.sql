ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "refinement_source_content" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "refinement_source_targets" jsonb;
