ALTER TABLE "jobs" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "source_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "company_label" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "manual_owner_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "manual_fingerprint" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input_kind" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "source_filename" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_manual_shape_chk" CHECK (
  (origin = 'manual' AND company_id IS NULL AND source_id IS NULL AND manual_owner_id IS NOT NULL
    AND manual_fingerprint IS NOT NULL AND company_label IS NOT NULL AND length(btrim(company_label)) > 0
    AND shared = false AND input_kind IS NOT NULL AND input_kind IN ('link', 'pdf')
    AND ((input_kind = 'link' AND url IS NOT NULL AND source_filename IS NULL)
      OR (input_kind = 'pdf' AND url IS NULL)))
  OR (origin <> 'manual' AND company_id IS NOT NULL AND source_id IS NOT NULL AND url IS NOT NULL
    AND manual_owner_id IS NULL AND manual_fingerprint IS NULL AND company_label IS NULL
    AND input_kind IS NULL AND source_filename IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_manual_owner_fingerprint_uidx" ON "jobs" ("manual_owner_id", "manual_fingerprint")
  WHERE manual_owner_id IS NOT NULL AND manual_fingerprint IS NOT NULL;--> statement-breakpoint
CREATE TABLE "role_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK (kind IN ('link', 'pdf')),
  "url" text,
  "filename" text,
  "source_bytes" text,
  "fingerprint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ready', 'failed', 'saved')),
  "title" text,
  "company_name" text,
  "location" text,
  "description_text" text,
  "truncated" boolean NOT NULL DEFAULT false,
  "error" text,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "role_imports_input_chk" CHECK ((kind = 'link' AND url IS NOT NULL AND source_bytes IS NULL) OR (kind = 'pdf' AND url IS NULL)),
  CONSTRAINT "role_imports_bytes_cap_chk" CHECK (source_bytes IS NULL OR length(source_bytes) <= 6990508),
  CONSTRAINT "role_imports_description_cap_chk" CHECK (description_text IS NULL OR length(description_text) <= 60000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "role_imports_user_fingerprint_uidx" ON "role_imports" ("user_id", "fingerprint");--> statement-breakpoint
CREATE INDEX "role_imports_user_created_idx" ON "role_imports" ("user_id", "created_at" DESC);
