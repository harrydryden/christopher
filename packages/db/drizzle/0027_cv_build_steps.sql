-- A CV build as a sequence of motions the person can watch and the system can learn from.
--
-- `cv_build_steps` records one row per motion (reading inputs, reserving budget, extracting the
-- rubric, each writing attempt, each measurement and trim, each assessment batch, scoring,
-- saving) with its timing, figures and result. The CV page reads the rows as a running
-- narrative; Operations aggregates them by motion. Rows are deleted with their draft.
--
-- `cv_drafts.build_checkpoint` keeps what a build has already paid for (the rubric, the moment
-- the written CV was saved) so a retry resumes instead of starting over. `cv_drafts.failure` is
-- the structured record of why the last attempt stopped and whose move it is.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "cv_build_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "cv_drafts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "task_id" uuid,
  "attempt" integer DEFAULT 1 NOT NULL,
  "seq" integer NOT NULL,
  "stage" text NOT NULL,
  "motion" text NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "ms" integer,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "failure" jsonb
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_build_steps_draft_seq_idx" ON "cv_build_steps" USING btree ("draft_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_build_steps_started_idx" ON "cv_build_steps" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "build_checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "failure" jsonb;
