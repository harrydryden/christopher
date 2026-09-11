# Final system audit — 11 September 2026

## Scope

Reviewed the integrated changes against main: queue claiming/recovery and operation leases, scan persistence, task deduplication, recommendation extraction/verification, spend reservations, database migrations, bounded queries, authenticated mutations, CV generation/evidence handling, PDF previews, revision persistence and simplified UI. Both development branches are included in this PR.

## Issues fixed during the final audit

- Preserved the bounded CV role selector when merging the CV layout branch. Neither the shared AI reservations nor structured skill/theme handling was replaced.
- Added independently paged saved and archived CV lists, stable tie-breakers and page clamping. The previous 50-row limit made older revisions unreachable through the list.
- Validated requested role IDs before querying PostgreSQL. Malformed 36-character values no longer produce a database UUID error.
- Reused daily scheduled scan tasks during Refresh, including their run-specific deduplication keys. Expediting a scan preserves its scan-run ID.
- Discarded scan results when the source was disabled or its URL changed during collection. A late scan cannot reactivate that source or reconcile stale postings.
- Made company-profile replacement atomic and fenced by task ownership. Failed or reclaimed work retains the previous profile; concurrent replacements serialise on the company row.
- Guarded repeated role-action clicks and keyboard submissions; failed requests leave an actionable error instead of an indefinitely pending editor.

## Refactoring

Extended the existing pagination component to support independent query parameters and accessible labels. Extracted bounded CV listing into a query function with integration coverage. Retained the shared PDF renderer for saved downloads and unsaved previews, the versioned CV palette schema, and the shared AI reservation mechanism.

Further improvements can be separate changes: extract the scan commit block from its large handler, separate source import/settings into dedicated routes if source counts grow, and add automated PDF geometry regression tests beyond the current renderer tests and visual fixtures. These are follow-up opportunities, not changes required for this PR.

## Verification

- 350 automated tests: 171 core, 24 AI, 86 worker and 69 web. Real PostgreSQL and Chromium were used; external company sites and paid AI responses were stubbed in tests.
- Workspace type checking and production builds passed. The final Refresh adjustment was rechecked with all 31 action/query integration tests and a fresh web build.
- All 13 production smoke-test routes rendered successfully, including CSV export.
- Browser checks verified role facts/filters, no table selection or expanders, Archive/Restore and Shortlist, visible source/review controls, and CV rendering/saving.
- Combined CV browser checks covered the navy/white workspace in dark OS mode, mobile overflow, unsaved PDF rendering without database writes, stale-preview invalidation, new revision persistence, malformed role IDs and saved-CV pagination.
- Prior 1,000-company/100,000-role synthetic benchmarks and their limitations are recorded in THOUSAND-COMPANY-READINESS.md. No production performance guarantee is inferred from local timings.

## Rollout

Apply additive database migrations 0008–0012 before exposing the updated web application. The worker runs migrations at startup; coordinate the web deployment so it does not query the new schema first. Keep the current three worker slots and one browser context initially. No hosting plan or production settings were changed in this audit.

After deployment, generate one real CV and compare preview/download, confirm an existing application's frozen PDF remains unchanged, then observe queue age, memory, source failures and AI spend during a real scheduled run. Provider latency, authenticated LinkedIn coverage and actual model usage remain production checks. Live scraping can require pasted newsletter text where sign-in is required. This PR is not a production deployment or merge to main.
