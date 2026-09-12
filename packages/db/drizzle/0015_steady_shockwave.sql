ALTER TABLE "jobs" ADD COLUMN "description_source" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "description_truncated" boolean DEFAULT false NOT NULL;