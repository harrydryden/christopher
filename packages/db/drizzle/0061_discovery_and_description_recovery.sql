ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "discovery_recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "discovery_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "discovery_recovery_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN IF NOT EXISTS "task_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN IF NOT EXISTS "homepage_url" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_task_idx" ON "discovery_runs" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_discovery_recovery_due_idx" ON "companies" ("discovery_next_attempt_at") WHERE "status" = 'active' AND "discovery_recovery_state" = 'waiting' AND "discovery_next_attempt_at" IS NOT NULL;--> statement-breakpoint
UPDATE "companies" c SET "discovery_recovery_state" = 'waiting', "discovery_next_attempt_at" = now() + interval '1 day'
WHERE c."status" = 'active' AND c."discovery_recovery_state" = 'idle'
  AND EXISTS (SELECT 1 FROM "company_subscriptions" sub WHERE sub."company_id" = c."id" AND sub."status" = 'active')
  AND NOT EXISTS (SELECT 1 FROM "career_sources" s WHERE s."company_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "tasks" t WHERE t."type" = 'discover' AND t."status" IN ('queued', 'running')
    AND t."payload"->>'companyId' = c."id"::text AND coalesce(t."payload"->>'logoOnly', 'false') <> 'true')
  AND coalesce((SELECT r."status" FROM "discovery_runs" r WHERE r."company_id" = c."id"
    ORDER BY r."started_at" DESC LIMIT 1), 'not_found') IN ('not_found', 'failed');--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "description_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "description_retry_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "description_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "description_last_error" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "description_input_revision" text;--> statement-breakpoint
UPDATE "jobs" SET "description_attempted_at" = "description_fetched_at", "description_fetched_at" = NULL
WHERE "description_text" IS NULL AND "description_fetched_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_description_due_idx" ON "jobs" ("description_next_attempt_at") WHERE "status" = 'open' AND "description_next_attempt_at" IS NOT NULL;
