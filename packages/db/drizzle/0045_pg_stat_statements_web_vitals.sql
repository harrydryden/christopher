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
