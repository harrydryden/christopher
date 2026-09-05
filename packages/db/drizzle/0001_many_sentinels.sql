ALTER TABLE "decisions" DROP CONSTRAINT "decisions_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;