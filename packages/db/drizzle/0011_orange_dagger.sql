ALTER TABLE "discovery_candidates" ALTER COLUMN "document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD COLUMN "similar_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD COLUMN "rank" integer;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD COLUMN "batch_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_candidate_batch_domain" ON "discovery_candidates" USING btree ("batch_key","domain");