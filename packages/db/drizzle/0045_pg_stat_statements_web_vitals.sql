-- Query-level statistics: what each normalised statement has cost this database in total execution
-- time, read by `pnpm cli pgstat` and the administrator's Operations card. Render lists the
-- extension as available; creating it needs the database owner, and it records nothing unless the
-- server preloads it (shared_preload_libraries). A role without the privilege, or a server built
-- without the contrib modules, must still migrate, so either skips with a notice and the readers say
-- why they have nothing to show.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_stat_statements not installed (%); create it as the database owner to enable pgstat', SQLERRM;
END
$$;
--> statement-breakpoint
-- Real-user Core Web Vitals, as one histogram per UTC day, route and metric: `/api/performance`
-- adds each sampled page load's final LCP, INP, CLS, TTFB and FCP to the log-scaled bucket its value
-- falls in (apps/web/lib/web-vitals.ts), and Operations reads the p75 from the counts. No event,
-- account, session or URL is stored. Ninety days are kept; the worker's monitor task runs the
-- retention every five minutes, and by hand it is:
--   DELETE FROM web_vitals WHERE day < (now() AT TIME ZONE 'utc')::date - 90;
CREATE TABLE IF NOT EXISTS "web_vitals" (
  "day" date NOT NULL,
  "route" text NOT NULL,
  "metric" text NOT NULL,
  "bucket" smallint NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "web_vitals_pkey" PRIMARY KEY ("day","route","metric","bucket")
);
