CREATE TABLE IF NOT EXISTS "evidence_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "input" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "wording" text,
  "supporting_quotes" jsonb,
  "error" text,
  "accepted_wording" text,
  "accepted_version" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_drafts_user_fingerprint_uidx" ON "evidence_drafts" ("user_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "evidence_drafts_open_user_idx" ON "evidence_drafts" ("user_id", "updated_at" DESC) WHERE "resolved_at" IS NULL;
