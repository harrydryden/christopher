-- The PDF a CV revision was rendered to, kept so a download serves it instead of rendering again
-- (docs/PERFORMANCE-GUIDE.md 3.13). Finalising already renders the revision to prove it lays out;
-- those bytes are stored here under the hash of what was rendered, the download serves them while
-- the hash still matches the revision, and recording an application copies them.
--
-- A table of its own rather than a bytea column on cv_drafts: many reads select every column of a
-- draft, and a PDF is hundreds of kilobytes that a `select *` would detoast on every one of them.
-- No foreign key, for the reason 0041 gives for cv_tailoring_plans (a key would make every
-- `truncate cv_drafts` name this table too); a delete trigger on cv_drafts, which cascaded deletes
-- fire as well, takes a draft's PDF with it. `user_id` scopes every read, as for any per-account row.
CREATE TABLE IF NOT EXISTS "cv_pdfs" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- A PDF is already compressed: store it out of line without trying to compress it again.
ALTER TABLE "cv_pdfs" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_pdfs_user_idx" ON "cv_pdfs" USING btree ("user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_cv_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cv_pdfs WHERE draft_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS cv_pdf_delete ON cv_drafts;--> statement-breakpoint
CREATE TRIGGER cv_pdf_delete AFTER DELETE ON cv_drafts
FOR EACH ROW EXECUTE FUNCTION delete_cv_pdf();
