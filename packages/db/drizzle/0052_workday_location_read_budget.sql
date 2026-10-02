-- Worker processes share one hourly source budget for Workday detail reads.
CREATE TABLE "workday_location_read_budgets" (
  "source_id" uuid PRIMARY KEY REFERENCES "career_sources"("id") ON DELETE CASCADE,
  "window_started_at" timestamptz NOT NULL,
  "request_count" integer NOT NULL CHECK ("request_count" BETWEEN 1 AND 50)
);
