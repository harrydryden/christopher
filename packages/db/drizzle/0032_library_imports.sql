-- Documents a person brings to the Library, and what the worker made of them.
--
-- Filling the Library is the highest-effort step in setting Christopher up, and every CV depends
-- on it, so a person should be able to start from a past CV, from LinkedIn's own PDF of their
-- profile, from their personal website or from a paste, rather than from an empty form.
-- `library_imports` is one row per attempt and holds the whole of that attempt's life: what
-- arrived, what the worker extracted from it, and whether the person has finished with the result.
--
-- `kind` is where the document came from — 'cv', 'linkedin', 'website' or 'paste' — and it decides
-- which of the next three columns is filled. `filename` names an upload so the person recognises
-- it; `url` is the person's own site, which is fetched through the polite fetcher because it is
-- theirs. LinkedIn is never crawled: the person exports LinkedIn's own PDF and uploads that.
--
-- `content` is the extracted text and it is what the extraction reads. It is nullable because it
-- is not always there at the start: a paste carries its text from the interface, but an upload
-- arrives as bytes and a website as a URL, and both become text in the worker, which already owns
-- every parser and has the headroom to run them. The check constraint repeats the interface's cap
-- of 40,000 characters, so a runaway document cannot be stored whatever calls the insert.
--
-- `source_bytes` and `source_mime` are the uploaded PDF or DOCX and its media type, capped at
-- 5 MB. They exist only to carry an upload from the interface to the worker: the worker converts
-- them, writes the text into `content`, and clears both columns in the same statement that records
-- the outcome — whether that outcome is a proposal or an error. Nothing binary outlives the
-- conversion, which is also why the bytes are not read back by any per-account query.
--
-- `fingerprint` is sha256 of whatever the import was given — the bytes for an upload, the stored
-- text for a paste, the normalised URL for a website. Unique per account, so importing the same
-- document twice reads the first import back instead of queueing a second extraction of the same
-- words. It is per account and not global because one person's import is not another's: the rows
-- are per-account data like every other thing the person wrote.
--
-- `proposal` is what the extraction proposes, as untyped jsonb. The shape is validated where it is
-- produced and the database is not the place to keep a second copy of that schema. It is a
-- proposal and never more: every item in it is accepted or dismissed by the person, accepted items
-- land as draft Library blocks, and the existing activate-and-confirm lifecycle stays the review
-- step. `error` is why an attempt produced nothing instead.
--
-- `processed_at` is when the worker finished, whichever way it went; `resolved_at` is when the
-- person accepted or dismissed the proposal, which is what takes the import off the Library page
-- and what makes a row eligible for pruning.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "library_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "filename" text,
  "url" text,
  "content" text,
  "source_bytes" bytea,
  "source_mime" text,
  "fingerprint" text NOT NULL,
  "proposal" jsonb,
  "error" text,
  "processed_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "library_imports_kind_check" CHECK ("kind" IN ('cv', 'linkedin', 'website', 'paste')),
  CONSTRAINT "library_imports_content_length_check" CHECK ("content" IS NULL OR length("content") <= 40000),
  CONSTRAINT "library_imports_source_bytes_length_check" CHECK ("source_bytes" IS NULL OR octet_length("source_bytes") <= 5242880)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_imports_user_idx" ON "library_imports" USING btree ("user_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_imports_user_fingerprint_uidx" ON "library_imports" USING btree ("user_id","fingerprint");
