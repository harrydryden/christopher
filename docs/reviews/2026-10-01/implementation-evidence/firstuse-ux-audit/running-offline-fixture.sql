-- Apply after queued-fixture.sql, only to isolated ava_firstuse_audit.
BEGIN;
UPDATE tasks SET status = 'running', started_at = now(), locked_at = now(), locked_by = 'synthetic-offline-worker'
WHERE type = 'scan_company';
COMMIT;
