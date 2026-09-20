# Christopher production audit — 20 September 2026

For the subsequent fixes, updated acceptance tooling and newer capacity/recovery results, see [release-gate development](RELEASE-DEVELOPMENT-2026-09-20.md). This audit remains the historical record of the initial pass.

## Verdict

**Not yet ready for unconditional production sign-off.** The application passes the local functional and capacity checks recorded below, and the audit fixes four security/reliability defects. Remaining release gates concern real-provider accuracy and CV quality, hosted capacity and connection headroom, managed backup recovery and operational ownership. These cannot be established by local tests or an idle health check.

The confirmed target is **100 registered users, around 10 active at once**. A 100-request burst was tested separately. Followed-company count, daily AI/import volume and recovery objectives remain assumptions to agree before release.

Started by fast-forwarding the existing `christopher` checkout from `f5e5c43` to `main` at `6a0ad4a67da2900712efbdc5dcc0737a762e1c9e`. Existing untracked duplicate files were preserved. Audit changes are isolated on `codex/production-review-20260920` in `christopher-production-review`. Sol sub-agents reviewed the web, backend and requirements independently; the lead reviewed their changes, added atomic public throttling and capacity evidence, and integrated verification. No deployment or production data mutation was performed.

## Findings and changes

| Priority | Finding | Resolution and evidence |
| --- | --- | --- |
| High | Concurrent administrator demotions could both pass a non-atomic check and remove all administrators. | `apps/web/app/actions/account.ts` locks administrator rows in deterministic order and checks the last-administrator rule in the same transaction as the change. The actions integration suite exercises opposing concurrent demotions and proves one administrator remains. |
| High | Public sharing and authentication used separate limit checks and attempt inserts, admitting a concurrent burst beyond the configured limit. | `apps/web/lib/rate-limit.ts` reserves all applicable keys transactionally with ordered advisory locks. Login, signup, reset, confirmation and public sharing use this common implementation. Successful login releases only its own IP reservation; concurrent failures remain counted. Integration tests prove bounded concurrent admission, mixed limits, expiry and targeted release. |
| High | Public CV comments parsed the whole form before checking field sizes. Oversized or malformed requests could consume memory or fail with a server error. | The comments route caps actual streamed bytes, handles missing/dishonest length headers and returns 413 or 400 before using invalid data. Oversized declared and headerless requests and malformed multipart are covered. |
| High | A Library import that lost its queue lease could publish a stale result or clear uploaded content needed by its replacement. | Every terminal import write now asserts queue ownership within the write transaction. The regression test proves proposal, error, completion time and source content remain untouched after loss of ownership. |
| Medium | Deployment instructions recommended six worker slots although the checked-in deployment evidence records OOM restarts at that setting. | `docs/DEPLOY.md` consistently recommends three slots on the stated small instance and explains the need to measure memory before increasing it. |
| Low | CV-share actions validated the record ID but interpolated an unchecked draft ID into cache invalidation paths. | Both identifiers must now be valid UUIDs. Account scoping of the actual mutation remains in the data helpers. |
| Medium | Recovery and rollback were open requirements without a usable procedure. | Added rollout, stop, rollback/roll-forward, isolated restoration and operational ownership checklists. A local logical backup/restore and restored-app smoke check were executed; managed production recovery remains unverified. |

Refactoring is limited to the common rate-limit reservation API and a fenced import-completion helper. No new dependencies or migrations are introduced.

## Requirements and Jobs to Be Done

The detailed [traceability matrix](PRODUCTION-REQUIREMENTS-2026-09-20.md) links the specification and the latest UX requirements to implementation and remaining acceptance evidence. Treat that document's repository evidence review alongside the executed results here; an implementation can be complete locally while production acceptance remains partial.

The browser smoke journey covers CV tabs, evaluation, keyboard navigation, saved edits, mobile layout, polling recovery, build progress/failure states, Library readiness and confirmation, unsaved-change protection, application stage/archive/restore/delete and unauthenticated share viewing/commenting. Scripted-model end-to-end tests exercise real actions, queue records, model-output validation and PDF generation; they do not prove the quality or price of a real model response.

Optional UX gaps remain: education/skill evidence badges, restoring historical Library versions and automatic completion of the company scoring timeline. They are recorded as refinements rather than silently added to launch blockers. No open GitHub issues or pull requests were returned during the audit; updated requirements were taken from the checked-in specification and dated UX document.

## Executed verification

- Fresh PostgreSQL 16 migrations succeeded on disposable databases, including all current account/import/sharing migrations.
- Core: 326 tests passed. AI: 77 passed. Worker: 257 passed; six browser-specific tests skipped with browser disabled in that suite. Real Chromium was exercised separately through the application smoke journey.
- Web: 490 tests passed in 60 files after the final authentication changes. Final production build and the authenticated route/Chromium smoke checks passed. Type checks passed across all packages; whitespace/error checks passed. The four package suites total 1,150 passed tests. The six initially skipped worker browser-specific tests were then run with Chromium enabled and all passed: **1,156 distinct tests passed overall**.
- Early checks overlapped work in progress and failed before fixes settled. The reported final checks were rerun. One CV writer retry test failed transiently in that early run; its full suite then passed, the isolated case passed five repeat runs, and the settled full worker run passed. No test was weakened to obtain a pass.

### Authenticated HTTP capacity

The [new repeatable benchmark](../scripts/benchmark-users.mjs) seeds 100 accounts, 20 shared companies, 1,000 jobs, 100,000 account-specific role records and 2,000 subscriptions in a dedicated local database. It starts the production Next.js build, uses actual session rows and cookies, warms six routes, then runs 600 requests at each concurrency. It rejects a non-local or incorrectly named database and does not clear existing data.

| Concurrent requests | Requests | Errors | Median | p95 | Maximum | Throughput |
| --- | --- | --- | --- | --- | --- | --- |
| 10 — target activity | 600 | 0 | 89 ms | 215 ms | 379 ms | 95.39 requests/s |
| 100 — separate burst | 600 | 0 | 1,072 ms | 1,415 ms | 1,694 ms | 94.79 requests/s |

Evidence: [HTTP results](benchmarks/hundred-users-2026-09-20.json). The flat throughput and increasing latency at 100 requests suggest queuing/saturation in this single-process setup; they do not identify its exact bottleneck. This is a short, no-think-time read probe. Applications and Library use empty states; roles and subscriptions are populated. It excludes real login hashing, writes, rich CV documents, AI, serverless instance fan-out and hosted database latency. Other tests ran on the same host against separate databases. No production capacity guarantee is inferred.

### Worker capacity and failure recovery

The current production queue benchmark ran with three reserved lanes, 1,000 companies and 100,000 shared jobs, using deterministic HTTP fixtures and zero AI calls.

| Phase | Seconds | Synthetic requests | Pending/failed tasks |
| --- | --- | --- | --- |
| Onboarding | 73.92 | 8,000 | 0 / 0 |
| Steady state | 18.50 | 3,000 | 0 / 0 |
| Temporary source failures | 16.06 | 2,960 | 0 / 0 |
| Recovery | 22.29 | 3,000 | 0 / 0 |

Every phase retained 100,000 jobs and 1,000 active sources. Source failures are recorded as scan failures, not failed queue tasks. Peak worker RSS was **311 MiB excluding Chromium**, and p95 of 1,309 concurrent company-list query samples was 7.03 ms. Evidence: [worker results](benchmarks/production-lanes-2026-09-20.json).

The onboarding shape now makes more requests than the 11 September benchmark, including logo work; these are not like-for-like timing samples. The local Node heap ceiling is also larger than the hosted worker's. A 311 MiB local process does not establish safe headroom on a 512 MB host with Chromium. Real remote pacing, descriptions, model calls and per-account fan-out remain release measurements.

### Local recovery drill

A PostgreSQL custom-format dump was restored into a new database with `pg_restore --exit-on-error`. Dump, restore and count/integrity comparisons took 2.42 seconds locally. Both databases held 100 users, 1,000 jobs, 100,000 user-job rows, 2,000 subscriptions, 100 sessions and 105 public constraints, with zero orphaned role views. The restored application passed the authenticated route and Chromium workflow smoke checks.

Evidence: [restore result](benchmarks/local-restore-2026-09-20.json). This establishes that this local fixture can be backed up and restored; it does not validate a managed backup, retention, encryption, production recovery time or acceptable data loss.

## Read-only deployment observations

The public worker health endpoint reported `ok: true` at the audited base commit `6a0ad4a`, zero ready/running work, zero overdue companies/discoveries and no memory pressure. Its snapshot showed 169 MiB RSS, 40 MiB used heap against a 259 MiB ceiling, and two idle database connections with none waiting. This was an idle point-in-time observation, not a load or availability test.

GitHub records show successful CI and Release runs for that base commit and a successful Vercel Production deployment created on 20 September at 07:19 UTC. These describe the deployed base, **not these unmerged audit fixes**. Render workspace inspection requires the user's workspace selection; the Vercel connector returned no teams. Hosted configuration, backup entitlement and active connection limits are therefore not certified by this review.

## Remaining release gates

1. Review and deploy the audit fixes through CI, then verify both worker and web release identities and a complete authenticated journey. No live release was performed here.
2. Confirm the authoritative hosted worker/database plans, concurrency and serverless connection budget. Run the agreed ten-active-user workload with representative populated CVs, writes and interactive jobs while daily scans run. Establish memory headroom with Chromium and hosted database latency.
3. Complete the specification's representative live-company discovery/recall acceptance and review a real generated CV for grounding, document quality, provider availability and measured cost. Local fixtures do not close these gates.
4. Verify managed backups, retention and access; agree RPO/RTO and restore an actual managed backup in isolation. Exercise release rollback or the documented roll-forward path against a production-like schema.
5. Assign operational ownership for stopped workers, overdue scans, repeated failures/restarts, queue growth, database exhaustion and spend. Configure and prove the alert/inspection path in the hosted environment.

Use the [deployment and recovery checklist](DEPLOY.md) and the [requirements matrix](PRODUCTION-REQUIREMENTS-2026-09-20.md) for release acceptance. Application-query tenant isolation, runtime task payload validation and unique worker-instance identifiers remain architectural considerations; no new cross-account data leak was reproduced in the audited paths. The review is broad, but it is not proof that every possible defect has been eliminated.
