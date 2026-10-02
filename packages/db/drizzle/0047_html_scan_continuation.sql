-- A deferred scan retains bounded, parsed page evidence outside the last-three scan snapshots.
ALTER TABLE "scans" ADD COLUMN "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "scans_task_source_uidx" ON "scans" ("task_id", "source_id") WHERE "task_id" IS NOT NULL;

CREATE TABLE "html_scan_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "career_sources"("id") ON DELETE CASCADE,
  "source_fingerprint" text NOT NULL,
  "next_url" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "restarts" integer NOT NULL DEFAULT 0,
  "bytes_stored" integer NOT NULL DEFAULT 0,
  "min_advertised" integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "html_scan_generation_task_source_uidx" ON "html_scan_generations" ("task_id", "source_id");
CREATE INDEX "html_scan_generation_expiry_idx" ON "html_scan_generations" ("expires_at");

CREATE TABLE "html_scan_pages" (
  "generation_id" uuid NOT NULL REFERENCES "html_scan_generations"("id") ON DELETE CASCADE,
  "page_index" integer NOT NULL,
  "url" text NOT NULL,
  "next_url" text,
  "content_hash" text NOT NULL,
  "semantic_hash" text NOT NULL,
  "role_set_hash" text NOT NULL,
  "postings" jsonb NOT NULL,
  "dropped" integer NOT NULL DEFAULT 0,
  "recipe" jsonb,
  "bytes_stored" integer NOT NULL,
  PRIMARY KEY ("generation_id", "page_index")
);
CREATE UNIQUE INDEX "html_scan_page_url_uidx" ON "html_scan_pages" ("generation_id", "url");
