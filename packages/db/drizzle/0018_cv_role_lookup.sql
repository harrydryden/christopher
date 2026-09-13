-- Inline immutable expression: either application version works before or after this migration.
CREATE INDEX cv_drafts_role_key_idx ON cv_drafts ((length(lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))))::text || ':' || lower(btrim(regexp_replace(company_name, '[[:space:]]+', ' ', 'g'))) || lower(btrim(regexp_replace(job_title, '[[:space:]]+', ' ', 'g')))));
