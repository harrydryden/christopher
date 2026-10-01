BEGIN READ ONLY;
WITH source_row AS (
  SELECT id, company_id, url, status, recipe, content_hash,
         consecutive_failures, last_ok_scan_at, next_scan_at, last_postings_count
  FROM career_sources
  WHERE url = 'https://jobs.siemens.com/en_US/externaljobs/SearchJobs/'
), generation_row AS (
  SELECT g.* FROM html_scan_generations g JOIN source_row s ON s.id = g.source_id
), page_rows AS (
  SELECT p.* FROM html_scan_pages p JOIN generation_row g ON g.id = p.generation_id
), job_rows AS (
  SELECT j.* FROM jobs j JOIN source_row s ON s.id = j.source_id
), event_rows AS (
  SELECT e.* FROM job_events e JOIN job_rows j ON j.id = e.job_id
)
SELECT jsonb_pretty(jsonb_build_object(
  'source', (SELECT to_jsonb(s) FROM source_row s),
  'generation', (SELECT to_jsonb(g) FROM generation_row g),
  'pages', (SELECT jsonb_build_object(
    'count', count(*), 'firstIndex', min(page_index), 'lastIndex', max(page_index),
    'distinctUrls', count(DISTINCT url), 'distinctContentHashes', count(DISTINCT content_hash),
    'earliestObservedAt', min(observed_at), 'latestObservedAt', max(observed_at),
    'stagedPostings', coalesce(sum(jsonb_array_length(postings)), 0)
  ) FROM page_rows),
  'jobs', (SELECT jsonb_build_object(
    'count', count(*), 'distinctExternalKeys', count(DISTINCT external_key),
    'distinctUrls', count(DISTINCT url), 'seeded', count(*) FILTER (WHERE seeded),
    'open', count(*) FILTER (WHERE status='open'),
    'closed', count(*) FILTER (WHERE status='closed'),
    'missingPositive', count(*) FILTER (WHERE missing_scans > 0),
    'firstMissedNonNull', count(*) FILTER (WHERE first_missed_at IS NOT NULL),
    'firstSeenAt', min(first_seen_at), 'lastSeenAt', max(last_seen_at)
  ) FROM job_rows),
  'views', (SELECT jsonb_build_object(
    'count', count(*), 'distinctJobs', count(DISTINCT uj.job_id),
    'seeded', count(*) FILTER (WHERE uj.seeded),
    'inTable', count(*) FILTER (WHERE uj.in_table),
    'scored', count(*) FILTER (WHERE uj.fit_score IS NOT NULL)
  ) FROM user_jobs uj JOIN job_rows j ON j.id=uj.job_id),
  'events', (SELECT jsonb_build_object(
    'count', count(*), 'discovered', count(*) FILTER (WHERE type='discovered'),
    'closed', count(*) FILTER (WHERE type='closed'),
    'byType', coalesce((SELECT jsonb_object_agg(type, n) FROM
      (SELECT type, count(*) n FROM event_rows GROUP BY type) x), '{}'::jsonb)
  ) FROM event_rows),
  'scans', (SELECT count(*) FROM scans sc JOIN source_row s ON s.id=sc.source_id),
  'aiCalls', (SELECT count(*) FROM ai_calls),
  'queuedTasks', (SELECT coalesce(jsonb_object_agg(type, n), '{}'::jsonb) FROM
    (SELECT type, count(*) n FROM tasks WHERE status='queued' GROUP BY type) x)
));
COMMIT;
