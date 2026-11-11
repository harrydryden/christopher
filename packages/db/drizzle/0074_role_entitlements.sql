CREATE TABLE IF NOT EXISTS "cv_opportunities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
  "canonical_ref" text,
  "legacy_root_draft_id" uuid,
  "first_success_operation_id" uuid,
  "first_success_at" timestamptz,
  "grandfather_proof" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cv_opportunities_success_pair_check" CHECK (("first_success_operation_id" IS NULL) = ("first_success_at" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_opportunities_user_job_uidx" ON "cv_opportunities" ("user_id", "job_id") WHERE "job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_opportunities_user_ref_uidx" ON "cv_opportunities" ("user_id", "canonical_ref") WHERE "canonical_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_opportunities_user_legacy_uidx" ON "cv_opportunities" ("user_id", "legacy_root_draft_id") WHERE "legacy_root_draft_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_opportunities_user_idx" ON "cv_opportunities" ("user_id", "created_at");--> statement-breakpoint
ALTER TABLE "cv_application_contexts" ADD COLUMN IF NOT EXISTS "opportunity_id" uuid REFERENCES "cv_opportunities"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "opportunity_id" uuid REFERENCES "cv_opportunities"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_application_contexts_opportunity_idx" ON "cv_application_contexts" ("user_id", "opportunity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_drafts_opportunity_idx" ON "cv_drafts" ("user_id", "opportunity_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_ai_usage" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "opportunity_id" uuid NOT NULL REFERENCES "cv_opportunities"("id") ON DELETE CASCADE,
  "request_key" text NOT NULL,
  "input_hash" text NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('inline_correction','inline_refine','inline_tailor','skills','check','whole_cv')),
  "price_version" integer NOT NULL CHECK ("price_version" > 0),
  "charge_kind" text NOT NULL CHECK ("charge_kind" IN ('role_credit','allowance')),
  "units" integer NOT NULL CHECK ("units" >= 0),
  "grant_id" uuid REFERENCES "credit_grants"("id") ON DELETE RESTRICT,
  "source_kind" text NOT NULL CHECK ("source_kind" IN ('draft','inline_run','skills_run')),
  "source_id" uuid NOT NULL,
  "five_hour_start" timestamptz,
  "week_start" timestamptz,
  "status" text NOT NULL DEFAULT 'reserved' CHECK ("status" IN ('reserved','consumed','released')),
  "reserved_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "cv_ai_usage_charge_check" CHECK (
    ("charge_kind" = 'role_credit' AND "grant_id" IS NOT NULL AND "units" = 0 AND "five_hour_start" IS NULL AND "week_start" IS NULL)
    OR ("charge_kind" = 'allowance' AND "grant_id" IS NULL AND "units" > 0 AND "five_hour_start" IS NOT NULL AND "week_start" IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_ai_usage_user_request_uidx" ON "cv_ai_usage" ("user_id", "request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_ai_usage_user_source_idx" ON "cv_ai_usage" ("user_id", "source_kind", "source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_ai_usage_first_claim_uidx" ON "cv_ai_usage" ("opportunity_id") WHERE "charge_kind" = 'role_credit' AND "status" IN ('reserved','consumed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_ai_usage_account_window_idx" ON "cv_ai_usage" ("user_id", "five_hour_start", "week_start", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_ai_usage_opportunity_idx" ON "cv_ai_usage" ("opportunity_id", "status");
