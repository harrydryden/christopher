ALTER TABLE "cv_drafts" ADD COLUMN "job_source" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN "assessment" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN "finalised_at" timestamp with time zone;