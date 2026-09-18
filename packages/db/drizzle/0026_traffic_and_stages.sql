-- Observability of external connections and the cost of a build.
--
-- `http_host_daily` is the per-host, per-day record of outbound traffic (requests, bytes, status
-- mix, rate limiting, blocking, robots denials, cap rejections, latency) that the fetcher and the
-- browser keep as counters and flush in batches. The per-request log line was the only record and
-- the platform drops it after days.
--
-- `scans.requests` / `scans.revalidated` say what one scan cost in requests and how many were
-- spared by revalidation. `ai_calls.stage` names the step of a multi-call feature (a CV build:
-- rubric, author, review, review_retry) so a build's cost can be explained. The new index serves
-- every per-feature aggregate, which was a full scan.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "http_host_daily" (
  "day" text NOT NULL,
  "host" text NOT NULL,
  "via" text NOT NULL,
  "requests" integer DEFAULT 0 NOT NULL,
  "bytes_in" bigint DEFAULT 0 NOT NULL,
  "ok_2xx" integer DEFAULT 0 NOT NULL,
  "not_modified_304" integer DEFAULT 0 NOT NULL,
  "redirects_3xx" integer DEFAULT 0 NOT NULL,
  "client_4xx" integer DEFAULT 0 NOT NULL,
  "server_5xx" integer DEFAULT 0 NOT NULL,
  "rate_limited" integer DEFAULT 0 NOT NULL,
  "blocked" integer DEFAULT 0 NOT NULL,
  "robots_denied" integer DEFAULT 0 NOT NULL,
  "cap_rejected" integer DEFAULT 0 NOT NULL,
  "timeouts" integer DEFAULT 0 NOT NULL,
  "network_errors" integer DEFAULT 0 NOT NULL,
  "duration_ms_sum" bigint DEFAULT 0 NOT NULL,
  "duration_ms_max" integer DEFAULT 0 NOT NULL,
  "latency_buckets" integer[] DEFAULT '{0,0,0,0,0,0}'::integer[] NOT NULL,
  CONSTRAINT "http_host_daily_pkey" PRIMARY KEY ("day","host","via")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "http_host_daily_day_idx" ON "http_host_daily" USING btree ("day");--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "requests" integer;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "revalidated" integer;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "stage" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_calls_site_at_idx" ON "ai_calls" USING btree ("call_site","at");
