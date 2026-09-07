# Efficiency improvements — 7 September 2026

## Runtime changes

1. The HTTP client retains a bounded, process-local validator cache (200 entries / 20 MB total / 2 MB per response). ETag or Last-Modified revalidation reuses a body on HTTP 304. Responses marked private/no-store are not added. Large feeds and sites without validators still transfer their responses. Stored job descriptions are reused for seven days only when the external ID and URL match and no newer provider timestamp is present; reuse does not extend the freshness timestamp.
2. Sparse-feed admission keeps only hashes and timestamps of rejected details, scoped to a source. Fingerprints include listing metadata and filters. Filter/metadata changes bypass the rejection; entries expire after seven days to catch undated changes. At most 10,000 fingerprints are retained per source. No rejected description or full job record is stored. Failures are deferred rather than cached as rejection.
3. Fit scoring hashes the job, actual profile/digest/evidence input and scoring model. Unchanged inputs with an existing score skip the AI call. Evidence and filter saves queue re-evaluation; shortlisted roles have priority 1. Rescoring no longer stops at the first 500 records. Saved CV generation remains an explicit user action and existing revisions are immutable.
4. Role filtering, sorting, counts and pagination now run in PostgreSQL. Only the requested 50-row page and up to 50 hidden rows load description payloads. A composite inbox index is added by migration 0005. Literal title/location searches retain substring semantics, including literal wildcard characters. CSV export retains all filtered records.
5. Pending company and CV work polls a small authenticated status endpoint, pauses in hidden tabs and stops at completion. Route refresh happens only when status changes or work completes, rather than every interval. This still refreshes the current Next.js route at a transition; it is not a new push-notification service or independent live table renderer.
6. Structured logs capture page navigation, role-query time, slow database queries (250 ms+; no SQL/parameters), HTTP duration/bytes and queue waiting time. Existing scan and AI records already retain duration. Authenticated GET /api/performance gives a database round-trip measurement and execution region. These are diagnostic measurements, not an SLO dashboard or a verified speedup claim.

## Production checks

Observed through hosting dashboards:

- Render worker and christopher-db: Frankfurt.
- Vercel function configuration: iad1 (North America).
- vercel.json now specifies fra1, matching the database location on the next deployment.
- Render's last successful worker deployment is **1ad3535 (PR #5)**. Later merged worker changes were not deployed. Deploy the updated worker after merging this release; a web-only deployment is insufficient.

No hosting plan was upgraded and no database was moved. The connected Vercel API returned 403; the signed-in dashboard provided region evidence instead. No production data migration or deployment was performed during these checks.

## Validation

Regression coverage includes conditional HTTP responses, changed filters bypassing rejected fingerprints, changed evidence invalidating scores, SQL paging/filtering and work-status completion. Type checks, production build and local page smoke tests use the separate local PostgreSQL databases. Apply migration 0005 during deployment. Use the new production measurements to quantify improvement after both services are updated.
