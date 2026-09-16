-- Multi-user accounts on a shared company catalogue.
--
-- Companies, careers sources, scans and observed postings stay shared and are scanned once a day
-- for everyone. Everything that expresses a person's choices gains a user_id: subscriptions to
-- companies, gate results and fit scores (moved off `jobs` into `user_jobs`), decisions, profiles,
-- suggestions, discovery sources, CVs, applications, reason tags and per-user settings.
--
-- A deployment that already holds single-user data gets a bootstrap owner account with a fixed id
-- and no way to sign in. The first person to register (or the first address listed in
-- ADMIN_EMAILS) claims it and inherits every company, role, decision and CV.

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text,
	"password_hash" text,
	"role" text DEFAULT 'member' NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_address" text
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "company_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_jobs" (
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"keyword_matched" boolean DEFAULT false NOT NULL,
	"keyword_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"location_ok" boolean DEFAULT true NOT NULL,
	"in_table" boolean DEFAULT false NOT NULL,
	"near_miss" boolean DEFAULT false NOT NULL,
	"fit_score" integer,
	"fit_verdict" text,
	"fit_rationale" text,
	"fit_profile_version" integer,
	"fit_scored_at" timestamp with time zone,
	"hidden" boolean DEFAULT false NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_jobs_user_id_job_id_pk" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD CONSTRAINT "user_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD CONSTRAINT "user_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_uidx" ON "auth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "login_attempts_key_at_idx" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_subscriptions_user_company_uidx" ON "company_subscriptions" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "company_subscriptions_company_idx" ON "company_subscriptions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "user_jobs_job_idx" ON "user_jobs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "user_jobs_table_idx" ON "user_jobs" USING btree ("user_id","in_table","archived_at","fit_score");--> statement-breakpoint

-- The bootstrap owner exists only where there is single-user data to inherit.
INSERT INTO "users" ("id", "email", "name", "role", "claimed_at")
SELECT '00000000-0000-4000-8000-000000000001', 'owner@christopher.invalid', 'Owner', 'admin', NULL
WHERE EXISTS (SELECT 1 FROM "companies") OR EXISTS (SELECT 1 FROM "jobs") OR EXISTS (SELECT 1 FROM "decisions")
   OR EXISTS (SELECT 1 FROM "cv_libraries") OR EXISTS (SELECT 1 FROM "cv_drafts") OR EXISTS (SELECT 1 FROM "applications")
   OR EXISTS (SELECT 1 FROM "preference_profiles") OR EXISTS (SELECT 1 FROM "filter_suggestions")
   OR EXISTS (SELECT 1 FROM "company_suggestions") OR EXISTS (SELECT 1 FROM "discovery_sources")
   OR EXISTS (SELECT 1 FROM "settings" WHERE "key" NOT LIKE 'internal:%');
--> statement-breakpoint

-- Per-user ownership columns: add nullable, inherit, drop strays, then require.
ALTER TABLE "ai_calls" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "company_suggestions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_libraries" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "filter_suggestions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "preference_profiles" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_vocabulary" ADD COLUMN "user_id" uuid;--> statement-breakpoint
UPDATE "applications" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "company_suggestions" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "cv_drafts" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "cv_libraries" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "decisions" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "discovery_candidates" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "discovery_sources" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "filter_suggestions" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "preference_profiles" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
UPDATE "tag_vocabulary" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
-- One person's events: scores, decisions, hide/unhide and archive/restore markers.
UPDATE "job_events" SET "user_id" = (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001')
WHERE "type" IN ('scored', 'decided', 'hidden', 'unhidden') OR ("type" = 'updated' AND "payload"->>'action' IN ('archived', 'restored'));--> statement-breakpoint
-- Rows that could not be inherited (a fresh database with seed tags, for example) have no owner.
DELETE FROM "applications" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "company_suggestions" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "cv_drafts" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "cv_libraries" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "decisions" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "discovery_candidates" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "discovery_sources" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "filter_suggestions" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "preference_profiles" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "tag_vocabulary" WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "company_suggestions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cv_drafts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cv_libraries" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "filter_suggestions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "preference_profiles" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_vocabulary" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_suggestions" ADD CONSTRAINT "company_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD CONSTRAINT "cv_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_libraries" ADD CONSTRAINT "cv_libraries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_suggestions" ADD CONSTRAINT "filter_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_profiles" ADD CONSTRAINT "preference_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_vocabulary" ADD CONSTRAINT "tag_vocabulary_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Uniqueness becomes per user.
ALTER TABLE "company_suggestions" DROP CONSTRAINT "company_suggestions_domain_unique";--> statement-breakpoint
ALTER TABLE "cv_libraries" DROP CONSTRAINT "cv_libraries_version_unique";--> statement-breakpoint
ALTER TABLE "preference_profiles" DROP CONSTRAINT "preference_profiles_version_unique";--> statement-breakpoint
ALTER TABLE "tag_vocabulary" DROP CONSTRAINT "tag_vocabulary_pkey";--> statement-breakpoint
ALTER TABLE "tag_vocabulary" ADD CONSTRAINT "tag_vocabulary_user_id_tag_pk" PRIMARY KEY("user_id","tag");--> statement-breakpoint
DROP INDEX "decisions_created_idx";--> statement-breakpoint
DROP INDEX "decisions_active_job_uidx";--> statement-breakpoint
DROP INDEX "suggestions_review_idx";--> statement-breakpoint
DROP INDEX "suggestions_history_idx";--> statement-breakpoint
CREATE INDEX "applications_user_idx" ON "applications" USING btree ("user_id","applied_on");--> statement-breakpoint
CREATE UNIQUE INDEX "company_suggestions_user_domain_uidx" ON "company_suggestions" USING btree ("user_id","domain");--> statement-breakpoint
CREATE INDEX "cv_drafts_user_idx" ON "cv_drafts" USING btree ("user_id","archived_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_libraries_user_version_uidx" ON "cv_libraries" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "decisions_user_created_idx" ON "decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_active_job_uidx" ON "decisions" USING btree ("user_id","job_id") WHERE "decisions"."superseded" = false;--> statement-breakpoint
CREATE INDEX "discovery_sources_user_idx" ON "discovery_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "filter_suggestions_user_status_idx" ON "filter_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "preference_profiles_user_version_uidx" ON "preference_profiles" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "suggestions_review_idx" ON "company_suggestions" USING btree ("user_id","status","rank","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_history_idx" ON "company_suggestions" USING btree ("user_id","status","resolved_at");--> statement-breakpoint

-- Per-user settings leave the system table; internal score fingerprints are re-keyed by user.
INSERT INTO "user_settings" ("user_id", "key", "value", "updated_at")
SELECT u."id", s."key", s."value", s."updated_at" FROM "settings" s CROSS JOIN "users" u
WHERE u."id" = '00000000-0000-4000-8000-000000000001'
  AND s."key" IN ('gate', 'hideThreshold', 'seedProfile', 'showClosedDays', 'descriptionMatchCompanyIds', 'suggestionsEnabled', 'cvModel', 'cvTheme', 'cvWritingPreferences');--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('gate', 'hideThreshold', 'seedProfile', 'showClosedDays', 'descriptionMatchCompanyIds', 'suggestionsEnabled', 'cvModel', 'cvTheme', 'cvWritingPreferences')
   OR "key" LIKE 'internal:scoreInput:%';--> statement-breakpoint

-- The owner follows every company it had; notes, pause and archive move to the subscription.
INSERT INTO "company_subscriptions" ("user_id", "company_id", "status", "notes", "added_at", "archived_at")
SELECT u."id", c."id", c."status", c."notes", c."added_at", c."archived_at" FROM "companies" c CROSS JOIN "users" u
WHERE u."id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "notes";--> statement-breakpoint

-- Gate results, fit scores and archive markers become the owner's view of each stored posting.
INSERT INTO "user_jobs" ("user_id", "job_id", "keyword_matched", "keyword_terms", "excluded", "location_ok", "in_table", "near_miss",
  "fit_score", "fit_verdict", "fit_rationale", "fit_profile_version", "fit_scored_at", "hidden", "seeded", "archived_at", "created_at", "updated_at")
SELECT u."id", j."id", j."keyword_matched", j."keyword_terms", j."excluded", j."location_ok", j."in_table", false,
  j."fit_score", j."fit_verdict", j."fit_rationale", j."fit_profile_version", j."fit_scored_at", j."hidden", j."seeded", j."archived_at", j."created_at", j."updated_at"
FROM "jobs" j CROSS JOIN "users" u WHERE u."id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
DROP INDEX "jobs_table_idx";--> statement-breakpoint
DROP INDEX "jobs_inbox_page_idx";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "keyword_matched";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "keyword_terms";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "excluded";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "location_ok";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "in_table";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "near_miss";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "fit_score";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "fit_verdict";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "fit_rationale";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "fit_profile_version";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "fit_scored_at";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "hidden";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "archived_at";--> statement-breakpoint

-- CV role keys are scoped by user: the index, the lookup and the daily version ledger all agree.
DROP INDEX "cv_drafts_role_key_idx";--> statement-breakpoint
CREATE INDEX "cv_drafts_role_key_idx" ON "cv_drafts" USING btree (("user_id"::text || ':' || length(lower(btrim(regexp_replace("company_name", '[[:space:]]+', ' ', 'g'))))::text || ':' || lower(btrim(regexp_replace("company_name", '[[:space:]]+', ' ', 'g'))) || lower(btrim(regexp_replace("job_title", '[[:space:]]+', ' ', 'g')))));--> statement-breakpoint
ALTER TABLE "cv_versions" ADD COLUMN "migrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "cv_versions" v SET "role_key" = d."user_id"::text || ':' || v."role_key", "migrated" = true FROM "cv_drafts" d WHERE d."id" = v."cv_id";--> statement-breakpoint
UPDATE "cv_versions" SET "role_key" = '00000000-0000-4000-8000-000000000001:' || "role_key", "migrated" = true
WHERE NOT "migrated" AND EXISTS (SELECT 1 FROM "users" WHERE "id" = '00000000-0000-4000-8000-000000000001');--> statement-breakpoint
DELETE FROM "cv_versions" WHERE NOT "migrated";--> statement-breakpoint
ALTER TABLE "cv_versions" DROP COLUMN "migrated";--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocate_cv_daily_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  role_key_value text;
  day_value text;
BEGIN
  role_key_value := NEW.user_id::text || ':' || length(lower(btrim(regexp_replace(NEW.company_name, '[[:space:]]+', ' ', 'g'))))::text || ':' ||
    lower(btrim(regexp_replace(NEW.company_name, '[[:space:]]+', ' ', 'g'))) ||
    lower(btrim(regexp_replace(NEW.job_title, '[[:space:]]+', ' ', 'g')));
  day_value := to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  PERFORM pg_advisory_xact_lock(hashtextextended(role_key_value, 0));
  INSERT INTO cv_versions (cv_id, role_key, day, version)
    SELECT NEW.id, role_key_value, day_value, coalesce(max(version), 0) + 1
    FROM cv_versions WHERE role_key = role_key_value AND day = day_value;
  RETURN NEW;
END;
$$;
