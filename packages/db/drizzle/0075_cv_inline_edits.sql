CREATE TABLE IF NOT EXISTS "cv_inline_edit_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "context_id" uuid NOT NULL REFERENCES "cv_application_contexts"("id") ON DELETE CASCADE,
  "request_key" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "usage_id" uuid NOT NULL,
  "input" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "proposed_text" text,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "cv_inline_edit_status" CHECK ("status" IN ('queued','ready','failed','dismissed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_inline_edit_runs_request_idx" ON "cv_inline_edit_runs" ("user_id","request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_inline_edit_runs_context_idx" ON "cv_inline_edit_runs" ("user_id","context_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_inline_edit_runs_input_idx" ON "cv_inline_edit_runs" ("user_id","context_id","input_hash");
