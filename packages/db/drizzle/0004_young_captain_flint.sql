CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cv_id" uuid NOT NULL,
	"job_title" text NOT NULL,
	"company_name" text NOT NULL,
	"applied_on" text NOT NULL,
	"pdf_base64" text NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"history" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_cv_id_cv_drafts_id_fk" FOREIGN KEY ("cv_id") REFERENCES "public"."cv_drafts"("id") ON DELETE no action ON UPDATE no action;