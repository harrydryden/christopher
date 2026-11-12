-- Completion notices are created only by new AI build transitions. No historical backfill:
-- an old CV must not appear as a fresh notification after deployment.
CREATE TABLE IF NOT EXISTS "cv_activity_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "cv_drafts"("id") ON DELETE CASCADE,
  "context_id" uuid,
  "company" text NOT NULL,
  "job_title" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('ready', 'failed')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "read_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_activity_events_user_recent_idx" ON "cv_activity_events" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_activity_events_unread_idx" ON "cv_activity_events" ("user_id", "created_at" DESC) WHERE "read_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_cv_activity_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('ready', 'failed') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  -- A manually saved revision has no generation; a build has a journal step or a generate_cv task.
  IF NEW.editing_mode = 'manual' OR NEW.model = 'manual' OR NOT (
    EXISTS (SELECT 1 FROM cv_build_steps s WHERE s.draft_id = NEW.id)
    OR EXISTS (SELECT 1 FROM tasks t WHERE t.type = 'generate_cv' AND t.payload->>'draftId' = NEW.id::text)
  ) THEN
    RETURN NEW;
  END IF;
  -- A retry's new terminal state supersedes its prior outcome for this exact draft.
  DELETE FROM cv_activity_events WHERE draft_id = NEW.id;
  INSERT INTO cv_activity_events (user_id, draft_id, context_id, company, job_title, status)
  VALUES (NEW.user_id, NEW.id, NEW.context_id, NEW.company_name, NEW.job_title, NEW.status);
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS cv_activity_completion ON cv_drafts;--> statement-breakpoint
CREATE TRIGGER cv_activity_completion AFTER UPDATE OF status ON cv_drafts
FOR EACH ROW EXECUTE FUNCTION record_cv_activity_completion();
