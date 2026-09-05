CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_site" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"ref_type" text,
	"ref_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"api_url" text,
	"ats_slug" text,
	"ats_site" text,
	"discovery_method" text,
	"confidence" real DEFAULT 0 NOT NULL,
	"confirmed_by_user" boolean DEFAULT false NOT NULL,
	"recipe" jsonb,
	"content_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_ok_scan_at" timestamp with time zone,
	"last_postings_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"homepage_url" text NOT NULL,
	"domain" text NOT NULL,
	"favicon_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "companies_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"one_liner" text,
	"sector" text,
	"sub_sector" text,
	"business_model" text,
	"customer_type" text,
	"stage" text,
	"size_band" text,
	"hq_country" text,
	"geographies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"homepage_url" text NOT NULL,
	"domain" text NOT NULL,
	"profile_id" uuid,
	"rationale" text,
	"similar_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification" jsonb,
	"rank" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "company_suggestions_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded" boolean DEFAULT false NOT NULL,
	"job_title" text NOT NULL,
	"company_name" text NOT NULL,
	"job_location" text,
	"job_department" text,
	"description_snippet" text,
	"fit_score_at_decision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_source_id" uuid,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "filter_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"value" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"url" text NOT NULL,
	"location" text,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"department" text,
	"employment_type" text,
	"remote" boolean,
	"salary_text" text,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"missing_scans" integer DEFAULT 0 NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"repost_of_job_id" uuid,
	"description_text" text,
	"description_hash" text,
	"description_fetched_at" timestamp with time zone,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"markdown" text NOT NULL,
	"pinned_statements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_decision_count" integer DEFAULT 0 NOT NULL,
	"model" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preference_profiles_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"run_date" text NOT NULL,
	"trigger" text NOT NULL,
	"companies_total" integer DEFAULT 0 NOT NULL,
	"companies_ok" integer DEFAULT 0 NOT NULL,
	"companies_failed" integer DEFAULT 0 NOT NULL,
	"new_roles" integer DEFAULT 0 NOT NULL,
	"closed_roles" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"fetch_method" text,
	"postings_found" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"closed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"duration_ms" integer,
	"raw_snapshot" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_vocabulary" (
	"tag" text PRIMARY KEY NOT NULL,
	"description" text,
	"created_by" text DEFAULT 'seed' NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "career_sources" ADD CONSTRAINT "career_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_suggestions" ADD CONSTRAINT "company_suggestions_profile_id_company_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."company_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_career_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."career_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_source_id_career_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."career_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_at_idx" ON "ai_calls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "career_sources_company_idx" ON "career_sources" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_active_job_uidx" ON "decisions" USING btree ("job_id") WHERE "decisions"."superseded" = false;--> statement-breakpoint
CREATE INDEX "decisions_created_idx" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_external_key_uidx" ON "jobs" USING btree ("source_id","external_key");--> statement-breakpoint
CREATE INDEX "jobs_company_status_idx" ON "jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "jobs_table_idx" ON "jobs" USING btree ("in_table","status","fit_score");--> statement-breakpoint
CREATE INDEX "jobs_first_seen_idx" ON "jobs" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "scans_source_started_idx" ON "scans" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "tasks_status_run_after_idx" ON "tasks" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_active_uidx" ON "tasks" USING btree ("dedupe_key") WHERE "tasks"."status" in ('queued', 'running') and "tasks"."dedupe_key" is not null;