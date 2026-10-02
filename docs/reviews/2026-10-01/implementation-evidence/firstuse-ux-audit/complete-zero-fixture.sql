-- Apply after queued-fixture.sql, only to isolated ava_firstuse_audit.
BEGIN;
UPDATE tasks SET status = 'done', finished_at = now(), result = '{}'::jsonb WHERE type = 'scan_company';
UPDATE career_sources SET last_ok_scan_at = now(), last_postings_count = 0;
INSERT INTO scans (source_id, task_id, finished_at, status, fetch_method, postings_found, new_count, closed_count)
SELECT s.id, t.id, now(), 'ok', 'http', 0, 0, 0
FROM career_sources s CROSS JOIN tasks t WHERE t.type = 'scan_company';
COMMIT;
