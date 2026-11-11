CREATE TABLE IF NOT EXISTS "career_heads" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL DEFAULT 0,
  "migrated_library_version" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_records" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('organisation','engagement','role','project','contribution','learning','qualification','skill','other')),
  "revision" integer NOT NULL,
  "fields" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_records_user_kind_idx" ON "career_records" ("user_id", "kind", "updated_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_links" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "from_id" uuid NOT NULL REFERENCES "career_records"("id") ON DELETE CASCADE,
  "to_id" uuid NOT NULL REFERENCES "career_records"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('employed_by','contracted_through','delivered_for','part_of','contributed_to','member_of')),
  "revision" integer NOT NULL,
  "confidential" boolean NOT NULL DEFAULT false,
  "public_label" text,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "career_links_distinct_check" CHECK ("from_id" <> "to_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_links_user_from_idx" ON "career_links" ("user_id", "from_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_links_user_to_idx" ON "career_links" ("user_id", "to_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_assertions" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subject_id" uuid NOT NULL REFERENCES "career_records"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "text" text NOT NULL,
  "public_text" text,
  "facets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "context" jsonb,
  "status" text NOT NULL CHECK ("status" IN ('usable','proposed','retracted')),
  "provenance" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_assertions_user_subject_idx" ON "career_assertions" ("user_id", "subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_assertions_user_status_idx" ON "career_assertions" ("user_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_perspectives" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "label" text NOT NULL,
  "note" text NOT NULL,
  "assertion_ids" jsonb NOT NULL,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "career_perspectives_user_idx" ON "career_perspectives" ("user_id", "updated_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "request_key" text NOT NULL,
  "intent_hash" text NOT NULL,
  "operations" jsonb NOT NULL,
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "undo_of" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_changes_user_request_uidx" ON "career_changes" ("user_id", "request_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_changes_user_revision_uidx" ON "career_changes" ("user_id", "revision");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "career_object_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "object_kind" text NOT NULL CHECK ("object_kind" IN ('record','link','assertion','perspective')),
  "object_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "change_id" uuid NOT NULL REFERENCES "career_changes"("id") ON DELETE CASCADE,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "career_object_versions_identity_uidx" ON "career_object_versions" ("user_id", "object_kind", "object_id", "revision");--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "career_version" integer;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "career_source_map" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "career_display" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "career_presentation" text;--> statement-breakpoint
ALTER TABLE "cv_auto_baselines" ADD COLUMN IF NOT EXISTS "career_version" integer;--> statement-breakpoint
ALTER TABLE "cv_auto_baselines" ADD COLUMN IF NOT EXISTS "career_source_map" jsonb;--> statement-breakpoint
ALTER TABLE "cv_auto_baselines" ADD COLUMN IF NOT EXISTS "career_display" jsonb;--> statement-breakpoint
ALTER TABLE "cv_auto_baselines" ADD COLUMN IF NOT EXISTS "career_presentation" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_shared_open_text_idx" ON "jobs" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("department", '') || ' ' || coalesce("description_text", '')))
  WHERE "shared" = true AND "manual_owner_id" IS NULL AND "status" = 'open';
