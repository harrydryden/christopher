CREATE TABLE "discovery_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"fingerprint" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_days" integer DEFAULT 7 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_suggestions" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "discovery_documents" ADD CONSTRAINT "discovery_documents_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_document_dedupe" ON "discovery_documents" USING btree ("source_id","fingerprint");