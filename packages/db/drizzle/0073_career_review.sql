CREATE TABLE IF NOT EXISTS "career_review_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conflict_id" text NOT NULL,
  "group_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "decision_revision" integer NOT NULL,
  "choice" text NOT NULL CHECK ("choice" IN ('choose','keep_both_context','correct','dismiss','later','reopen')),
  "selected_assertion_id" uuid,
  "statement_snapshot" jsonb NOT NULL,
  "career_version" integer,
  "request_key" text NOT NULL,
  "intent_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_review_events_user_request_uidx" ON "career_review_events" ("user_id", "request_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_review_events_group_revision_uidx" ON "career_review_events" ("user_id", "conflict_id", "decision_revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_review_events_history_idx" ON "career_review_events" ("user_id", "conflict_id", "decision_revision" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_review_events_source_idx" ON "career_review_events" ("user_id", "career_version" DESC);
