-- Fences for a CV build that runs beside its siblings.
--
-- `ai_reservations.ref_id` names what a hold is for — for a CV build, its draft. A build is
-- admitted once and holds its share of the account's budget for the whole build, so two builds of
-- one account hold two reservations at once. Every release was scoped to the account, which meant
-- abandoning one build released the other's hold as well: its renewal then updated nothing, the
-- budget forgot it, and a third build was admitted that the month could not afford. With the
-- reference recorded, a release names the build it is giving back.
--
-- `cv_build_steps (draft_id, seq)` becomes unique. `seq` is allocated as `max(seq) + 1`, and two
-- attempts of one draft under READ COMMITTED can read the same maximum and land on the same
-- number, leaving the narrative with two rows claiming one place. The allocation now runs under an
-- advisory lock on the draft; the index is what makes that guarantee the database's rather than
-- the worker's. Existing rows are renumbered in their current order first, so the index can be
-- created on any deployment's history.
--
-- Idempotent throughout.

ALTER TABLE "ai_reservations" ADD COLUMN IF NOT EXISTS "ref_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_reservations_ref_idx" ON "ai_reservations" USING btree ("ref_id");--> statement-breakpoint
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "draft_id" ORDER BY "seq", "started_at", "id") AS "position"
  FROM "cv_build_steps"
)
UPDATE "cv_build_steps" SET "seq" = ordered."position"
FROM ordered WHERE ordered."id" = "cv_build_steps"."id" AND "cv_build_steps"."seq" <> ordered."position";--> statement-breakpoint
DROP INDEX IF EXISTS "cv_build_steps_draft_seq_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_build_steps_draft_seq_uniq" ON "cv_build_steps" USING btree ("draft_id","seq");
