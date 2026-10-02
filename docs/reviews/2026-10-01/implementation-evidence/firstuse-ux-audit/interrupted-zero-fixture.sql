-- Apply after complete-zero-fixture.sql, only to isolated ava_firstuse_audit.
BEGIN;
DELETE FROM scans;
UPDATE career_sources SET last_ok_scan_at = NULL, last_postings_count = NULL;
UPDATE tasks SET status = 'failed', error = 'Synthetic interrupted read before any page was published',
  finished_at = now(), result = NULL WHERE type = 'scan_company';
INSERT INTO html_scan_generations (task_id, source_id, source_fingerprint, next_url, expires_at, published_page_count)
SELECT t.id, s.id, 'synthetic-firstuse-zero', s.url, now() + interval '1 hour', 0
FROM tasks t CROSS JOIN career_sources s WHERE t.type = 'scan_company';
COMMIT;
