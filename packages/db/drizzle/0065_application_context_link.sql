ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "context_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_user_context_idx" ON "applications" ("user_id", "context_id", "created_at" DESC) WHERE "context_id" IS NOT NULL;
