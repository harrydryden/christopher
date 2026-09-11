CREATE TABLE "discovery_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"homepage_url" text NOT NULL,
	"rationale" text NOT NULL,
	"quote" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_document_id_discovery_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."discovery_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_candidate_document_domain" ON "discovery_candidates" USING btree ("document_id","domain");