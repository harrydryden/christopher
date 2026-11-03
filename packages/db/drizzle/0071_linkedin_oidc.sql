CREATE TABLE IF NOT EXISTS "linkedin_auth_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "state_hash" text NOT NULL UNIQUE,
  "nonce_hash" text NOT NULL,
  "browser_hash" text NOT NULL,
  "intent" text NOT NULL,
  "pending_kind" text,
  "initiating_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "target_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "initiating_session_id" uuid,
  "next_path" text NOT NULL DEFAULT '/',
  "subject" text,
  "provider_email" text,
  "provider_email_verified" boolean NOT NULL DEFAULT false,
  "name" text,
  "chosen_email" text,
  "email_token_hash" text,
  "app_email_verified_at" timestamptz,
  "callback_used_at" timestamptz,
  "verified_at" timestamptz,
  "completed_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "linkedin_auth_transactions_expires_idx" ON "linkedin_auth_transactions" ("expires_at");
CREATE INDEX IF NOT EXISTS "linkedin_auth_transactions_subject_idx" ON "linkedin_auth_transactions" ("subject");
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "auth_provider" text;
