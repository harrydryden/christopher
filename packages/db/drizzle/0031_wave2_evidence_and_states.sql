-- Why a score is missing, what an application owes next, and how much evidence an entry carries.
--
-- Three unrelated-looking additions that share one idea: the product already knows these things
-- and throws them away, so the interface has to render an em dash and the person has to guess.
--
-- `user_jobs.score_state` / `score_state_at`. A blank fit score covers five situations the score
-- handler already distinguishes and then discards: a task is queued, the stored score stands, the
-- posting closed before it was ever scored, the account's budget was spent, or the role was
-- neither in the table nor shortlisted when the task ran. Recording which one means the table can
-- say "scoring…" or "not scored: budget spent" instead of one dash for all five. Nullable, so
-- every existing row reads "nothing recorded" and the interface falls back to the score itself
-- (R-9.6): no backfill can honestly say which of the five an old row was.
--
-- `applications.next_action` / `next_action_on`. A stage history knows only when it was saved, so
-- an interview on Tuesday could not be recorded as a date at all. `next_action` is what the person
-- owes next in their own words (the interface caps it at 200 characters) and `next_action_on` is
-- the day it is due. Both are days and free text, not enums: this is the person's own note to
-- themselves, not a workflow. The matching `on` on each history entry is a type change only — the
-- column is already jsonb and the field is optional, so nothing stored needs rewriting.
--
-- `cv_library_reviews`. The evidence review of one library entry: each row's facet and whether it
-- is specific, quantified and linked to an outcome; which of the six facets are covered; up to
-- three questions that would raise it; and the score code computed from all of that. It is its own
-- table rather than a column on `cv_libraries` because a library version is immutable and a review
-- is not part of what the person wrote — it arrives after the save and can be recomputed.
-- `input_hash` covers the entry's rows, its facets and the job it belongs to, so a typo fix
-- re-reviews one entry while every unchanged entry carries its review forward to the new version;
-- the unique index is what makes one review per (account, version, entry), and the entry index is
-- what makes "the newest matching review for this entry, from any version" one cheap lookup.
-- A score here gates nothing: it informs the person, as the fit score ranks a role without ever
-- removing it.
--
-- Idempotent throughout.

ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "score_state" text;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "score_state_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "next_action" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "next_action_on" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_library_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "library_version" integer NOT NULL,
  "entry_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "score" integer NOT NULL,
  "rating" text NOT NULL,
  "source" text NOT NULL,
  "review" jsonb NOT NULL,
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cv_library_reviews_version_entry_uidx" ON "cv_library_reviews" USING btree ("user_id","library_version","entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_library_reviews_entry_idx" ON "cv_library_reviews" USING btree ("user_id","entry_id","created_at" DESC);
