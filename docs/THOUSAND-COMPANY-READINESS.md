# 1,000-company readiness

## Scope and acceptance

Support a single user tracking 1,000 companies with daily vacancy scans and configurable weekly external discovery. Capacity depends on vacancies, provider latency and AI usage, not just company count. All benchmarks use a disposable local database and synthetic HTTP responses; production completion times require observation.

1. **Worker safety:** renewable task leases, ownership-checked completion and failure, bounded stale recovery; reserve capacity for interactive, scanning and background work. Preserve company reconciliation serialisation without holding transactions over network calls. Test stale owners, competing claims and recovery.
2. **Durable discovery:** separate collection, document extraction and candidate verification, checkpoint extracted candidates, deduplicate by canonical domain and retain source evidence. Retries must not repeat successful extraction. Paused sources must stop downstream work.
3. **Database efficiency:** batch daily fan-out and job/event/task writes; chunk gate reads and run large filter changes in the background; index queue/run, source and review access paths. Keep reconciliation atomic.
4. **Lean browsing:** searchable, paginated companies and recommendations with stable ordering and counts; fetch related data only for the current page. Paginate company roles and history.
5. **AI efficiency:** bounded representative context plus current preferences and relevant examples; retain full deterministic domain exclusions. Reserve concurrent spend before calls and account for actual usage. Avoid repeating candidate verification.
6. **Scheduling and resources:** configurable scheduled scan spreading, bounded browser concurrency, shared host pacing and provider backoff. Keep manual work responsive. Size pools deliberately; do not change paid hosting plans without measured need.
7. **Retention and observability:** bounded cleanup, retain deduplication fingerprints and user decisions; expose queue age, task duration, overdue sources, memory and spend. Preserve latest successful extraction snapshots.
8. **Validation:** automated regression checks and repeatable 1,000-company onboarding and steady-state benchmark, including slow/failing sources and concurrent queue consumers; document timings, environment and limitations. No paid model calls or external company crawling during load tests.

## Rollout

Apply additive database migrations before new workers. Restart workers together when changing task handling. Use one worker initially; increase capacity only after checking queue age, browser memory, database connections and provider limits. Existing work and user decisions must survive upgrades. New task types require the updated worker.

## Evidence

Implementation and measured results are recorded below as work completes.

## Implementation

- Task leases renew every 30 seconds. Completion/failure compare both owner and attempt. Scans, CV generation, extraction and verification also use renewable operation leases and fenced result transactions. A busy operation is deferred without spending a retry attempt.
- Three or more worker slots reserve separate interactive, scan and background lanes. Each group of three adds one slot per lane. Smaller workers rotate lanes. Queue ageing improves the priority of work waiting five minutes or more. The default three-slot worker therefore has **one guaranteed scan slot**, not three unrestricted scan slots.
- Network and model work run outside scan and CV write transactions. Reconciliation commits atomically. Daily fan-out, inserts, refreshes, events and follow-up tasks use batches. Filter reads use 250-job pages; settings changes affecting more than 500 jobs queue re-evaluation. Worker startup also queues this work rather than blocking health reporting.
- Collection stores pages and queues extraction. Extraction stores evidence-backed candidates and queues independent verification. A document's `processed_at` now means extraction was checkpointed; candidate `processed_at` means verification finished. Source checks resume unprocessed candidates, including after a pause. Similar-company searches also checkpoint candidates. Failed tasks remain retryable in Health.
- Verification is cached per domain, filter configuration and matching mode for seven days (one day for a negative result), with shared operation leases preventing duplicate concurrent verification. Tracked and previously suggested domains are excluded in database checks, including dismissed and expired suggestions.
- Recommendation context uses at most 40 examples: relevance-ranked examples plus sector coverage. It includes bounded sector totals, the latest preference profile, filters and recent rejection reasons. A deterministic context hash identifies that input; the full portfolio does not enter each newsletter prompt.
- Companies, review/history and company roles use pages of 50 with deterministic tie-breakers. Company/recommendation search runs in SQL; related company data is scoped to the page. Health attention lists cap at 100 and omit raw snapshots.
- Model requests reserve estimated spend atomically before dispatch, across processes. Monthly, optional daily and optional discovery limits share the same ledger. Known usage releases unused reserved capacity; unknown usage is conservatively charged at the reservation estimate. SDK retries are disabled to avoid hidden repeat calls. CV requests use the same controls. Reservations abandoned for 15 minutes are conservatively charged when the next request checks the ledger.
- `SCAN_SPREAD_MINUTES` defaults to 60 for scheduled scans; manual scans are immediate. Repeated failed sources back off for 1, 2, 4, then 7 days; manual scans can bypass that delay. HTTP and browser document/API requests share host pacing through Postgres. HTTP `Retry-After` defers that host by at most one hour. `BROWSER_CONCURRENCY` defaults to one context per process.
- Hourly maintenance removes at most 1,000 old tasks, scan records and transient job events per category. Tasks retain 30 days. Scans/events retain 90 days plus the latest three scans and last successful scan. Newsletter body text is cleared after 90 days only once its candidates are processed; fingerprints, titles, evidence and user decisions remain. Verification cache and inactive host pacing entries expire.
- Health reports ready/running work, oldest ready-task age, task-duration p95, overdue companies/sources and reserved AI cost. The worker health endpoint also reports process memory. Existing slow-query and task-duration logs remain available.

## Operating limits

These are estimated spend controls, not a provider-side hard billing cap: token estimation, server-side tools, unknown outcomes and provider price changes prevent that guarantee. Keep the provider's account spending controls enabled where available. Discovery's optional daily allowance covers A7, A8 and A10 model calls; role scoring and CVs retain their own access to the overall budget.

Worker concurrency remains 3 and paid hosting plans remain unchanged. A replica increases pool and browser memory demand. Each worker pool uses `max(4, concurrency + 2)` connections; each web process uses 3. Before adding replicas, measure total connections and memory including Chromium. Model/tool usage and live provider rates require production observation.

A source's edition-link traversal still has the existing ten-link bound and is not a complete LinkedIn edition catalogue. Authentication walls still require importing text. These changes preserve those source coverage limits.

## Measured validation (11 September 2026)

A disposable PostgreSQL 16 database on an Apple M4 (24 GiB host RAM, Node 22.18.0) held 1,000 companies and 100,000 jobs. Three concurrent queue consumers ran real ATS discovery, adapters, reconciliation and persistence against synthetic responses. No external websites or paid models were called.

| Phase | Seconds | Synthetic requests | Retained jobs | Pending/failed tasks |
| --- | ---: | ---: | ---: | ---: |
| Onboarding, including source discovery and first scan | 13.53 | 5,000 | 100,000 | 0 / 0 |
| Unchanged daily scan | 14.07 | 1,000 | 100,000 | 0 / 0 |
| 20 temporarily failing/slow sources | 16.70 | 1,000 | 100,000 | 0 / 0 |
| Recovery | 16.51 | 1,000 | 100,000 | 0 / 0 |

The failed source scans were recorded as failures without closing or deleting their retained jobs; their queue tasks completed with that result. Recovery restored successful scans. The benchmark asserts job/source totals and absence of unfinished/failed tasks after every phase.

Peak worker RSS was 290 MiB, excluding Chromium. Across 609 concurrent company-list query samples, p95 was 4.58 ms. This is a **database query measurement**, not browser page latency. The three unrestricted benchmark consumers are deliberately different from the default production lanes, which reserve one of three slots for scans. Real provider delay, live browser work, model latency/cost and remote database performance must be measured before setting production completion targets.

Reproduce with an empty local database named `christopher_scale_benchmark` and `pnpm benchmark:scale`. The script refuses other database names and non-local hosts; it does not clear existing data. Set `SCALE_DATABASE_URL` for a different local port and `SCALE_REPORT_PATH` for the JSON report destination. The benchmark now defaults to the actual production queue: three reserved lanes, default polling, heartbeat/completion handling and graceful shutdown. Set `SCALE_QUEUE_MODE=unrestricted` only to reproduce the earlier unrestricted-consumer comparison. Each production phase fails on failed tasks or after five minutes rather than waiting indefinitely.

The 100,000-role smoke test also exposed a 31 MB CV selector. That selector now uses server-side search and a maximum of 50 matches, preserving a specifically requested role even if it falls outside that page.

## Interface verification

With the benchmark dataset loaded, real Chromium checks covered company paging/search/detail navigation, company-role paging, recommendation paging/search, adding and dismissing recommendations while preserving the current page, review history, source management, CV role search and Health. The tested views had no document overflow at a 390 px viewport and no page errors. The production smoke test rendered all 13 routes, including the CSV export.

The CV page response fell from 31,214,121 bytes to 42,204 bytes after bounding its selector. This is response size, not a compression-adjusted transfer figure. Recorded local page checks ranged from roughly 23 to 818 ms; they are observations, not a production latency guarantee.

Manual daily fan-out now saves its scan-run checkpoint in the same transaction as its tasks, so recovery after commit does not create another run. Weekly scheduling uses a shared transaction lock across worker instances.

Bulk company imports normalise/deduplicate first, then insert companies and their discovery tasks atomically in batches of 100. Duplicate-import feedback is bounded so repeating a 1,000-company import cannot produce an oversized redirect URL. An integration test exercises the complete action with 1,000 URLs and a repeated import.

Verification passed: 333 distinct automated tests (165 core, 23 AI, 84 worker, 61 web), TypeScript checks, production build, 13-route smoke test and Chromium UI checks. The final added bulk-import test was run with its complete 24-test action suite after the full suite; no paid model calls or production data were used.


## Resumed implementation verification

The scaling work remains on `codex/thousand-company-readiness`; CV visual changes are separately held on `codex/cv-layout-rules`. Neither set has been merged or deployed. Before a combined release, integrate both branches and rerun the CV generation/AI budget tests together. This avoids replacing either the new CV theme/skill handling or the shared model-spend reservation path.

The benchmark now exercises the actual production queue by default. The production-lane run used one interactive, one scan and one background slot, including normal three-second idle polling and graceful shutdown:

| Phase | Seconds | Retained jobs | Unfinished / failed tasks |
| --- | ---: | ---: | ---: |
| Onboarding | 29.04 | 100,000 | 0 / 0 |
| Daily scan | 20.01 | 100,000 | 0 / 0 |
| Source disruption | 21.61 | 100,000 | 0 / 0 |
| Recovery | 19.09 | 100,000 | 0 / 0 |

Peak benchmark-process RSS was 190 MiB; 897 concurrent company-list query samples had a p95 of 22.60 ms. The regression suite and production build ran on the same host during early phases, against a separate database in the same PostgreSQL container. Treat this as validation under shared local load, not an isolated performance comparison or a promise of live scan times. HTTP responses were synthetic; no browser crawling or paid model calls took place in the benchmark.

All 333 regression tests passed again, including real Chromium tests, along with workspace type checking and the production build. Production migrations and hosting settings were not changed. Five additive migrations (0008–0012) must be applied as part of rollout before serving the updated code. The existing default of three worker slots and one browser context per worker is unchanged.
