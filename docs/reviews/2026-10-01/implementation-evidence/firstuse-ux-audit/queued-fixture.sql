-- Run only against the isolated ava_firstuse_audit clone of the synthetic 25-page fixture.
BEGIN;
DELETE FROM html_scan_generations;
DELETE FROM scans;
DELETE FROM jobs;
DELETE FROM tasks WHERE type <> 'scan_company';
UPDATE tasks SET status = 'queued', error = NULL, result = NULL, started_at = NULL,
  finished_at = NULL, locked_at = NULL, locked_by = NULL,
  run_after = now() + interval '5 minutes' WHERE type = 'scan_company';
UPDATE career_sources SET last_ok_scan_at = NULL, last_postings_count = NULL;
COMMIT;
