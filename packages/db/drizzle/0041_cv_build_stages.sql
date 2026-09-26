-- The CV build pipeline's stage runner (docs/SPEC.md, "CV builder").
--
-- 1. The tailoring plan a published CV was written against stays beside its assessment, so the
--    build can be replayed and explained; it used to be discarded with the checkpoint at
--    publication. A table of its own rather than a column on cv_drafts: the interface selects
--    every column of cv_drafts, and deploys separately from the worker that migrates. No foreign
--    key either, because a key would make every `truncate cv_drafts` name this table too; a
--    delete trigger on cv_drafts (which cascaded deletes fire as well) takes a draft's plan with it.
CREATE TABLE IF NOT EXISTS "cv_tailoring_plans" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_tailoring_plans_user_idx" ON "cv_tailoring_plans" USING btree ("user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_cv_tailoring_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cv_tailoring_plans WHERE draft_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS cv_tailoring_plan_delete ON cv_drafts;--> statement-breakpoint
CREATE TRIGGER cv_tailoring_plan_delete AFTER DELETE ON cv_drafts
FOR EACH ROW EXECUTE FUNCTION delete_cv_tailoring_plan();--> statement-breakpoint
-- 2. Every CV build's task names its account, as every per-account payload must. Builds already
--    queued or running are given theirs from the draft, so the fair claim below counts them.
UPDATE "tasks" t SET "payload" = t."payload" || jsonb_build_object('userId', d."user_id"::text)
  FROM "cv_drafts" d
  WHERE t."type" = 'generate_cv' AND t."status" IN ('queued', 'running')
    AND t."payload"->>'userId' IS NULL AND d."id"::text = t."payload"->>'draftId';--> statement-breakpoint
-- 3. The claim orders CV builds by how many the same account already has running, so an account's
--    first build starts before anyone's second. That count reads this index: small, because it
--    holds running CV builds only.
CREATE INDEX IF NOT EXISTS "tasks_cv_running_user_idx" ON "tasks" USING btree (("payload"->>'userId')) WHERE "type" = 'generate_cv' AND "status" = 'running';
