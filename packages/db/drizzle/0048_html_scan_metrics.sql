-- Generation counters are committed at each hand-off and read in the final scan transaction.
-- A crashed claim or source replacement makes precise totals unavailable rather than too small.
ALTER TABLE "html_scan_generations" ADD COLUMN "requests" integer NOT NULL DEFAULT 0;
ALTER TABLE "html_scan_generations" ADD COLUMN "fetched_bytes" integer NOT NULL DEFAULT 0;
ALTER TABLE "html_scan_generations" ADD COLUMN "revalidated" integer NOT NULL DEFAULT 0;
ALTER TABLE "html_scan_generations" ADD COLUMN "active_duration_ms" integer NOT NULL DEFAULT 0;
ALTER TABLE "html_scan_generations" ADD COLUMN "metrics_complete" boolean NOT NULL DEFAULT true;
ALTER TABLE "html_scan_generations" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "scans" ADD COLUMN "elapsed_ms" integer;
ALTER TABLE "scans" ADD COLUMN "metrics_complete" boolean NOT NULL DEFAULT true;
