-- Showing one CV to one person, and hearing what they think of it.
--
-- The second opinion is the thing people actually ask for before they apply, and the product had
-- nothing share-shaped: a CV could be downloaded and emailed, which loses the revision, the
-- assessment beside it and any way of hearing back. A scoped link is narrower than the non-goal
-- the SPEC states: one revision of one document, read-only, revocable, expiring, with no session
-- and no reach into the account.
--
-- `cv_shares` is that link. It is modelled on `auth_tokens` — only a hash of the token is stored,
-- so the link sitting in a reviewer's inbox cannot be recovered from a database backup — and
-- differs in being multi-use: a reviewer opens it as often as they like until it expires or is
-- revoked. `expires_at` is set by the interface (fourteen days by default) and `revoked_at` is the
-- owner ending it early; a share is live only while neither has happened, and the lookup is the
-- one place that decides it. `view_count` and `last_viewed_at` are what let the owner see that the
-- link was actually read, which is the question they ask a day later.
--
-- `user_id` is the owner. It is what makes a public route obey the rule that nothing per-account
-- is read without a `userId`: the route authenticates by token, the share yields the account and
-- the draft, and every read after that is scoped by the account on the row rather than by anything
-- the visitor supplied. `draft_id` cascades, so deleting a CV takes its links with it.
--
-- `cv_share_comments` is what a reader leaves behind. `anchor` is an id the assessment already
-- cites — the profile block or a section block — so a reader's note and the reviewer's finding sit
-- beside the same text; it is free text with a length cap at this layer because the ids are the
-- CV's, not the database's. `author_name` is what the reader called themselves, unverified and
-- shown as such, and `body` is the note, capped at 2,000 characters and never empty.
--
-- `user_id` is on the comment as well as the share, denormalised from it, so that every read of a
-- comment is scoped by account without depending on anyone remembering the join; the two indexes
-- are the two reads — one share's thread in order, and this account's open notes. `resolved_at` is
-- the owner marking a note dealt with, which is the owner's action and no one else's.
--
-- Nothing a reader writes reaches a model call unless the owner copies it there: a comment is
-- data, exactly as an imported document is, never an instruction.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "cv_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "cv_drafts"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "allow_comments" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "view_count" integer DEFAULT 0 NOT NULL,
  "last_viewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cv_shares_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_shares_user_draft_idx" ON "cv_shares" USING btree ("user_id","draft_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_share_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "share_id" uuid NOT NULL REFERENCES "cv_shares"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "anchor" text NOT NULL,
  "author_name" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "cv_share_comments_anchor_length_check" CHECK (length("anchor") > 0 AND length("anchor") <= 120),
  CONSTRAINT "cv_share_comments_author_name_length_check" CHECK (length("author_name") > 0 AND length("author_name") <= 80),
  CONSTRAINT "cv_share_comments_body_length_check" CHECK (length("body") >= 1 AND length("body") <= 2000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_share_comments_share_idx" ON "cv_share_comments" USING btree ("share_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_share_comments_user_open_idx" ON "cv_share_comments" USING btree ("user_id","resolved_at");
