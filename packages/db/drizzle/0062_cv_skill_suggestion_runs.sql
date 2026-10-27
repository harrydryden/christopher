CREATE TABLE IF NOT EXISTS "cv_skill_suggestion_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "cv_drafts"("id") ON DELETE CASCADE,
  "library_version" integer NOT NULL,
  "input_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "suggestions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "accepted_selection_hash" text,
  "accepted_draft_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_skill_suggestion_runs_user_draft_idx" ON "cv_skill_suggestion_runs" ("user_id", "draft_id", "created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_skill_suggestion_runs_active_uidx" ON "cv_skill_suggestion_runs" ("draft_id") WHERE "status" IN ('queued', 'running');
