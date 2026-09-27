# A. Measured performance baseline: AVA interface

Evidence only. No fixes are proposed here. Every number below was measured on 2026-09-26 against the production build in
`apps/web/.next`, built from HEAD `8c2ac58`.

## How it was measured

| Item | Setup |
|---|---|
| Database | `ava_perf_bench`, migrated with `pnpm db:migrate`, then loaded with the INSERT block from `scripts/benchmark-users.mjs` (copied to `scratchpad/perf/a/seed.mjs`; the repo was not modified). |
| Fixture | 100 accounts, 20 companies (2/3 greenhouse and 1/3 html sources), 50 jobs per company (1,000 jobs, each description about 5 KB), every account following 20 companies, **100,000 `user_jobs`**, one Library, one ready CV draft and one application per account. Extra data for load user 1 only: 40 decisions and 1,000 per-user `scored` job_events. Everyone gets 1,000 shared `new` job_events, one finished scan run (20 scans) and 13 more days of scans (280 scans in total). `analyze` was run afterwards. |
| Server | `next start -p 3151`, `NODE_ENV=production`, `AVA_DISABLE_BROWSER=1`. The web pool is `max: 3` (`apps/web/lib/db.ts:12`). |
| Auth | A forged `ava_session=v2.<id>.<exp>.<hmac>` cookie for load user 1 (`load-1@benchmark.invalid`, not an admin), made exactly as in benchmark-users.mjs. |
| Timing | Node `fetch` with sequential requests on one warm server. 10 requests per path, the first 2 discarded, **n = 8 warm requests**. The time runs from request to the last body byte. Nearest-rank percentiles, so with n = 8 the p95 is the maximum. |
| Sizes | "HTML B" is the decompressed body. "gzip B" is `zlib.gzipSync` at the default level, compressed by me. `next start` itself answers with `Content-Encoding: gzip`, and Vercel's edge would serve brotli, which is somewhat smaller. |
| SQL | Postgres 16 logs every statement with its duration (`log_min_duration_statement = 0`; the cluster also has `log_statement = all` set globally). Each request is bracketed by `select 'MARK-START …'` / `select 'MARK-END …'` on a separate connection. Statements between the markers from other backends of `ava_perf_bench` are counted. **Statements** means execute and simple-query lines. **SQL ms sum** is parse + bind + execute durations added across all connections (bind includes planning for unnamed statements). pg_stat_statements is not preloaded, so it was not used. |
| Duplicates | "exact dup" means the same SQL text with the same parameters issued more than once in one request. It is taken from the last warm request of each path. Statement counts per path were identical across all 8 warm requests (min = max), so the set is stable. |
| Round-trip sensitivity | Local latency is about 0 ms, so I measured how many **sequential** DB round trips each request really pays. The server was pointed at a local TCP relay (`scratchpad/perf/a/proxy.mjs`, NODELAY) that adds a fixed delay to every client-to-server packet, which charges +D ms per round trip. I ran every page through the relay at D=0 and D=20 ms. **Effective sequential RTs = (p50@20 − p50@0) / 20.** A D=5 run is also shown; it is noisier. |
| Scripts | `scratchpad/perf/a/{seed,bench,analyse,s7,phases,cold}.mjs`, `js.py`. Raw data is in `raw-*.json` and `summary-*.json`. |

**Caveats.**
- Single 4-vCPU machine, local Postgres 16, no network. Other audit runs shared the host (load average 1.2–2.4) and ran their own Next server on 3152. Absolute ms therefore wander by ±20–30 % between runs (for example `/` p50 was 62.7, 71.0 and 62.5 ms in three separate runs).
- Production has about **1–5 ms per DB round trip** (Vercel fra1 to Render Frankfurt PgBouncer). There, the sequential round-trip count matters more than any local statement duration.
- The fixture's library, CV and application documents are small, and no account follows fewer than 20 companies. Because `follows == companies == 20`, **every account follows every company**. Step 8's "account that follows the most" does not differ; I measured a second account (load user 51) as a control.

---

## 1. Per-page server timings and payloads (load user 1, warm, n=8)

| path | status | p50 ms | p95 ms | HTML B | HTML gzip B | RSC B (`RSC: 1`) | RSC gzip B | RSC p50 ms | RSC p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 200 | 62.7 | 166.9* | 243,984 | 22,206 | 90,824 | 12,390 | 46.0 | 50.6 |
| `/?view=auto-matched` | 200 | 64.9 | 93.6 | 244,056 | 22,240 | 90,852 | 12,411 | 42.7 | 47.5 |
| `/companies` | 200 | 71.9 | 78.6 | 233,088 | 18,524 | 99,116 | 8,911 | 35.1 | 39.3 |
| `/companies?tab=discover` | 200 | 57.9 | 136.4* | 233,132 | 18,551 | 99,139 | 8,931 | 33.6 | 45.4 |
| `/companies/<id>` | 200 | 68.4 | 82.0 | 227,967 | 20,532 | 92,693 | 11,813 | 37.7 | 44.0 |
| `/applications` | 200 | 45.5 | 51.8 | 86,680 | 11,504 | 28,251 | 6,228 | 38.3 | 45.8 |
| `/library` | 200 | 36.7 | 46.5 | 73,555 | 11,243 | 26,555 | 5,151 | 19.7 | 27.3 |
| `/cv` | 307 → redirect | 6.6 | 7.2 | 0 | – | 0 | – | 6.0 | 7.3 |
| `/cv/<draftId>` (ready) | 200 | 36.5 | 43.3 | 58,481 | 10,488 | 22,201 | 4,938 | 21.4 | 24.9 |
| `/suggestions` | 200 | 30.3 | 32.6 | 35,093 | 7,344 | 15,993 | 4,363 | 18.3 | 22.1 |
| `/settings` | 200 | 31.9 | 38.9 | 63,557 | 11,382 | 23,958 | 5,882 | 21.8 | 39.0 |
| `/learning` | 200 | 46.3 | 53.2 | 101,038 | 12,228 | 46,067 | 6,761 | 26.9 | 30.6 |
| `/health` | 200 | 28.1 | 33.7 | 34,624 | 7,012 | 15,670 | 4,086 | 18.7 | 23.4 |
| `/account` | 200 | 25.3 | 34.3 | 38,107 | 7,567 | 16,360 | 4,329 | 16.7 | 20.2 |
| `/api/work-status?scope=company` | 200 | 10.9 | 13.6 | 61 | – | – | – | – | – |
| `/api/scan-status` | 200 | 15.7 | 18.4 | 149 | – | – | – | – | – |

\* A single outlier from host noise. A 20-request rerun gave `/` p50 71.0 / p95 92.0 ms and `/companies` 63.6 / 86.4 ms (section 3).

Observations (measured):
- **TTFB is about 16–24 ms on every page** (curl `time_starttransfer`, 8 runs each on `/`, `/companies`, `/applications`, `/library`), while the full body takes 28–68 ms. The `(app)/loading.tsx` shell streams first; the rest arrives as the data resolves.
- **The HTML document carries the RSC payload inline**: `self.__next_f` scripts are 42 % of `/` (104,729 of 243,858 B), 48 % of `/companies` (114,026 B), 39 % of `/applications` and 54 % of `/learning`.
- **What makes `/` large**: one RSC line of **63,556 B** carries the `rows` prop of the client roles table for 48 rows, about 1.3 KB of serialized props per row (every job column, company favicon/logo/domain, decision fields).
- **What makes `/companies` large**: 20 rows produce 99 KB of RSC. Each company row is about 4.4 KB. Most of that is the per-row "Manage" `<details>` containing forms, bound server-action references (`$h…`), client-component props and repeated long Tailwind class strings (26 KB of `className` values across 538 elements; the company id appears 9 times per row).
- An RSC (client-navigation) request is **17–37 ms faster than the HTML request** for the same page. That difference is the cost of SSR-rendering HTML on top of the flight payload.
- Page responses are `Cache-Control: private, no-cache, no-store`. The static CSS/JS is `public, max-age=31536000, immutable`.

## 2. SQL per request

| path | statements / request | on every page (shell) | page-specific | SQL ms sum (parse+bind+exec, all conns) | slowest statement (ms, what) | exact duplicates (distinct / extra executions) | pool conns used |
|---|---|---|---|---|---|---|---|
| `/` | **20** | 9 | 11 | 31.3 | **19.9** role-page query (`select companies.id, … from user_jobs join jobs … order by … limit 50`) | 0 / 0 | 3 |
| `/?view=auto-matched` | 20 | 9 | 11 | 30.9 | 13.7 same role-page query | 0 / 0 | 3 |
| `/companies` | 18 | 9 | 9 | 9.8 | 2.1 company list query | 0 / 0 | 3 |
| `/companies?tab=discover` | 18 | 9 | 9 | 8.9 | 1.1 company list query | 0 / 0 | 3 |
| `/companies/<id>` | **33** | 9 | 24 | 26.6 | 2.9 role-page query (company-scoped) | **1 / 1** (`discovery_runs` by company, 2×) | 3 |
| `/applications` | **25** | 9 | 16 | 19.8 | 2.0 stage/role index union query | **2 / 3** (`settings where key not like 'internal:%'` 3×; `user_settings where user_id=$1` 2×) | 3 |
| `/library` | 17 | 9 | 8 | 6.8 | 1.1 role-stage summary | 1 / 1 (`settings` 2×) | 3 |
| `/cv` | 0 | – | – | 0 | – (307 redirect before any DB access) | – | 0 |
| `/cv/<draftId>` | 18 | 9 | 9 | 8.3 | 1.3 role-stage summary | 0 / 0 | 3 |
| `/suggestions` | 16 | 9 | 7 | 6.8 | 1.4 role-stage summary | 2 / 2 (`company_suggestions` count 2×; `settings` 2×) | 3 |
| `/settings` | 15 | 9 | 6 | 5.7 | 1.1 role-stage summary | 2 / 3 (`settings` 3×; `user_settings` 2×) | 3 |
| `/learning` | 17 | 9 | 8 | 6.5 | 1.0 role-stage summary | 1 / 1 (`settings` 2×) | 3 |
| `/health` | 16 | 9 | 7 | 9.2 | 1.0 role-stage summary | 0 / 0 | 3 |
| `/account` | 10 | 9 | 1 | 5.0 | 5.0 role-stage summary (a one-off; usually about 1) | 0 / 0 | 3 |
| `/api/work-status?scope=company` | **2** | – | – | 1.2 | 0.07 tasks `count + md5(string_agg)` | 0 / 0 | 1 |
| `/api/scan-status` | 7 | – | – | 3.4 | 0.9 role-stage summary | 0 / 0 | 3 |

**Nine statements run on every authenticated page** (the app shell/layout plus auth), in this order of issue:
1. `sessions` lookup (auth),
2. `settings where key not like 'internal:%'` (global settings),
3. latest `scan_runs` row,
4. `max(scans.finished_at)` join `career_sources`,
5. `count(*) company_subscriptions where user_id=$1 …`,
6. `count(*) company_suggestions where user_id=$1 and status=$2`,
7. the per-user **role-stage summary** (`select case when user_jobs.archived_at … from user_jobs … decisions …`, about 0.7–1.1 ms execute),
8. `count(*) company_subscriptions cs join companies …`,
9. the per-user model-budget query (`select u.id as user_id, budget.value …`).

Most pages also issue `tasks count + md5(...)` (the work-status version), `users.role, email_verified_at`, a `user_settings` read and the Library entry count.

Parse, bind and planning overhead is large relative to execution. Every statement is an unnamed extended-protocol statement, so it is re-parsed and re-planned on each request. Median values per request, 20-request runs:

| path | SQL sum (parse+bind+exec) | exec only | parse+bind share |
|---|---|---|---|
| `/` | 34.5 ms | 20.3 ms | 14.2 ms (41 %) |
| `/companies` | 10.3 ms | 3.1 ms | 7.2 ms (70 %) |
| `/companies/<id>` | 21.6 ms | 5.0 ms | 16.6 ms (77 %) |

The single most expensive planning cost is the role-stage/role-index union statement: parse 0.7 + bind 2.1–2.7 ms per request on `/` and `/companies/<id>`.

**Role-page query on `/` (EXPLAIN ANALYZE, user 1, limit 50):**
- Planning 3.3 ms, execution 10.5 ms.
- Postgres estimates `rows=1` for the join chain that actually yields **960 rows**, then top-N heapsorts all 960 on a computed CASE sort key to return 50.
- The same filter runs a second time as a separate `count(*)` statement for pagination (5.7 ms exec + 1.3 ms parse/bind).
- The seq scan on `jobs` (1,000 rows) plus nested-loop index probes into `user_jobs` (960 loops) is fine at this size, but it grows linearly with an account's followed-jobs count, not with the page size.

## 3. Sequential round trips, which is the production-relevant number

`p50@0` goes through the relay with no delay. `p50@20` adds 20 ms per client-to-server packet. n = 8 per path per configuration.

| path | statements | p50 @ +0 ms | p50 @ +20 ms/RT | **effective sequential RTs** | projected DB-wait at 1 ms RT | at 5 ms RT | (noisier +5 ms run: RTs) |
|---|---|---|---|---|---|---|---|
| `/` | 20 | 91.3 | 243.7 | **7.6** | ~8 ms | ~38 ms | 3.7 |
| `/?view=auto-matched` | 20 | 80.1 | 233.9 | **7.7** | ~8 ms | ~38 ms | 1.3 |
| `/companies` | 18 | 93.7 | 209.9 | **5.8** | ~6 ms | ~29 ms | 1.6 |
| `/companies?tab=discover` | 18 | 74.9 | 207.0 | **6.6** | ~7 ms | ~33 ms | 4.2 |
| `/companies/<id>` | 33 | 80.6 | 377.6 | **14.8** | ~15 ms | ~74 ms | 12.6 |
| `/applications` | 25 | 68.8 | 325.8 | **12.8** | ~13 ms | ~64 ms | 11.4 |
| `/library` | 17 | 47.7 | 185.4 | **6.9** | ~7 ms | ~34 ms | 4.4 |
| `/cv/<draftId>` | 18 | 39.1 | 224.3 | **9.3** | ~9 ms | ~46 ms | 5.2 |
| `/suggestions` | 16 | 29.3 | 151.2 | **6.1** | ~6 ms | ~30 ms | 5.5 |
| `/settings` | 15 | 35.8 | 154.2 | **5.9** | ~6 ms | ~30 ms | 5.0 |
| `/learning` | 17 | 42.0 | 171.2 | **6.5** | ~6 ms | ~32 ms | 4.1 |
| `/health` | 16 | 30.8 | 156.4 | **6.3** | ~6 ms | ~31 ms | 5.3 |
| `/account` | 10 | 26.0 | 111.0 | **4.2** | ~4 ms | ~21 ms | 1.9 |
| `/api/work-status?scope=company` | 2 | 11.2 | 55.4 | **2.2** | ~2 ms | ~11 ms | 2.1 |
| `/api/scan-status` | 7 | 14.4 | 77.7 | **3.2** | ~3 ms | ~16 ms | 3.3 |
| `/cv` (redirect) | 0 | 8.6 | 10.5 | 0.1 | 0 | 0 | – |

How to read this:
- The statements are issued **partly in parallel**. The log shows 3 backend pids per request, with statements interleaved across them (for `/`, 5/7/8 statements per connection, and 10/14/9 on `/companies/<id>`).
- The web pool is **`max: 3`**, so the floor is about statements / 3 waves:
  - `/` is 20/3 ≈ 7 and measured 7.6.
  - `/companies` is 18/3 = 6 and measured 5.8.
  - Those pages are essentially **pool-width-bound**, not chain-bound.
- Pages clearly above statements / 3 have real sequential dependency chains:
  - `/companies/<id>`: 14.8 measured against 11.
  - `/applications`: 12.8 against 8.3.
  - `/cv/<id>`: 9.3 against 6.
- The +5 ms run is inconsistent with the +20 ms run: at small delays, partially overlapping waves hide some of the latency. Treat the +20 ms column as the robust estimate, and the projections as proportional estimates.
- Even `/api/work-status`, the poll every open tab makes every 10 s during a run, pays 2 sequential round trips: the session lookup, then the tasks version.

## 4. Server-side render cost breakdown (20 warm requests each, 18 counted)

The time between markers comes from the SQL log. "SQL wall (union)" is the union of the statements' [start, end] intervals, which accounts for the parallel connections. Log timestamps have ms resolution, so union and span are ±1 ms.

| path | p50 ms | p95 ms | statements | SQL sum (all conns) | SQL exec only | SQL wall, union of intervals | first SQL start to last SQL end | **rest (p50 − SQL wall) = render/compute/queueing** | statements per connection |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 71.0 | 92.0 | 20 | 34.5 | 20.3 | 19.1 | 37.0 | **51.9** | 5 / 7 / 8 |
| `/companies` | 63.6 | 86.4 | 18 | 10.3 | 3.1 | 5.9 | 16.2 | **57.7** | 5 / 5 / 8 |
| `/companies/<id>` | 65.0 | 82.6 | 33 | 21.6 | 5.0 | 11.9 | 32.4 | **53.2** | 10 / 14 / 9 |

- **Locally, render dominates**: 73 % of `/`, 91 % of `/companies` and 82 % of `/companies/<id>` wall time is outside SQL. This matches the HTML-vs-RSC gap of 17–37 ms, plus flight serialization of the 90–100 KB payloads.
- **Statements within one request run on 3 connections concurrently.** Their intervals overlap (9–29 overlapping cross-connection pairs per request), but the first-to-last SQL span is about 2× the union. SQL is spread across the render in dependent waves, not issued in one burst.
- In production, add about 7.6 / 5.8 / 14.8 round trips × 1–5 ms to these three pages for DB latency alone, plus PgBouncer.

## 5. Client JavaScript per route (from `.next/app-build-manifest.json` + `build-manifest.json` rootMainFiles)

First-load JS is the union of rootMainFiles + `/layout` + `/(app)/layout` (+ `/(app)/admin/layout`) + the route's own chunks, with each file counted once. Sizes are on-disk bytes; gzip is level 9, computed by me.

- **Shared by every app route: 350,700 B raw / 102,402 B gzip** (webpack runtime, `45bf4544` = react-dom, `3445` = next client, `main-app`).
- The two layouts add 19,395 B / 7,650 B.
- `polyfills-*.js` (112,594 / 39,373) is `nomodule`. It appears in the HTML but modern browsers skip it. It is excluded below.

| route | JS files | first-load JS raw | gzip | route-specific raw | gzip |
|---|---|---|---|---|---|
| `/cv/[id]` | 10 | 545,750 | **162,161** | 175,655 | 52,109 |
| `/library` | 10 | 517,319 | **152,970** | 147,224 | 42,918 |
| `/settings` | 10 | 480,654 | **142,391** | 110,559 | 32,339 |
| `/companies/[id]` | 10 | 417,128 | 125,570 | 47,033 | 15,518 |
| `/` | 10 | 411,548 | 123,394 | 41,453 | 13,342 |
| `/applications` | 9 | 395,259 | 119,046 | 25,164 | 8,994 |
| `/suggestions` | 8 | 388,717 | 116,217 | 18,622 | 6,165 |
| `/companies` | 9 | 377,352 | 113,275 | 7,257 | 3,223 |
| `/admin` | 9 | 377,355 | 112,987 | 7,037 | 2,755 |
| `/admin/catalogue` | 9 | 378,120 | 112,969 | 7,802 | 2,737 |
| `/learning` | 8 | 375,071 | 111,726 | 4,976 | 1,674 |
| `/admin/settings` | 9 | 372,156 | 111,156 | 1,838 | 924 |
| `/account` | 8 | 371,933 | 110,976 | 1,838 | 924 |
| `/admin/health` | 9 | 370,555 | 110,431 | 237 | 199 |
| `/cv/library` | 8 | 370,318 | 110,232 | 223 | 180 |
| `/health` | 8 | 370,281 | 110,216 | 186 | 164 |
| `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/verify` | 7 | 360,080 | 106,295 | 8,770 | 3,572 |
| `/share/[token]` | 6 | 351,533 | 102,903 | 223 | 180 |

**The 10 largest client chunks** (of 62 files, 1,149,713 B total):

| chunk | raw | gzip | included by |
|---|---|---|---|
| `framework-50cf…js` | 189,759 | 59,397 | pages-router only (`/_app`, `/_error`); not in any app route's first load |
| `3445-b45d…js` | 173,625 | 46,195 | every route (root main) |
| `45bf4544-6c71…js` | 173,110 | 54,287 | every route (root main; react-dom) |
| `main-6c36…js` | 128,917 | 37,251 | pages-router only |
| `polyfills-4237…js` | 112,594 | 39,373 | every HTML page, `nomodule` (legacy browsers only) |
| `9269-5f56…js` | **86,614** | **23,798** | `/cv/[id]`, `/library`, `/settings`. Content is **zod** (v4 error codes `invalid_format`, `string_format` …). Client components importing `zod`, `@ava/core` or `@ava/ai` include `CvDraftEditor`, `CvLibraryEditor`, `CvAppearance`, `CvGapQuiz`, `EmploymentHistoryTable`, `LibraryRowTypeMenu`, `RolesTable`, `ApplicationsTable` and `EvidenceScore` (grep). |
| `app/(app)/cv/[id]/page-b0ec…js` | 70,489 | 21,692 | `/cv/[id]` |
| `app/(app)/library/page-e0d3…js` | 42,058 | 12,501 | `/library` |
| `482-2119…js` | 32,661 | 9,613 | `/`, `/companies/[id]` (roles table: apply/skip buttons) |
| `app/(app)/applications/page-4737…js` | 19,168 | 6,455 | `/applications` |
| (11th) `3906-71c3…js` | 18,552 | 6,619 | `/cv/[id]`, `/library`, `/settings` (Library entry kinds) |

**CSS**: a single `static/css/232b1ddffd6cbdd3.css`, **41,191 B raw / 8,530 B gzip**, shared by every route.

**Fonts**: every HTML response preloads 5 woff2 files through the `link` header: 3,208 + 10,060 + 3,528 + 10,052 + 10,120 = **36,968 B**.

## 6. Other account, and cold start

**Second account (load user 51; same follows, no decisions or events)**, n=8:

| path | p50 | p95 | HTML B | stmts | SQL sum |
|---|---|---|---|---|---|
| `/` | 75.0 | 85.3 | 236,874 | 20 | 30.5 |
| `/companies` | 75.4 | 78.5 | 229,689 | 18 | 9.6 |
| (user 1 in the same session, control) `/` | 62.5 | 69.4 | 244,034 | 20 | 29.3 |
| (user 1 control) `/companies` | 65.1 | 73.3 | 233,088 | 18 | 9.5 |

The same statement counts and shapes: statement count does not depend on the account's data here. The time differences are within host noise.

**Cold start** (server killed, restarted; time from spawn until port 3151 accepts, then the first requests), 3 trials:

| trial | port open | first `/` | second `/` | first `/companies` | second `/companies` |
|---|---|---|---|---|---|
| 1 | 669 ms | **1,935 ms** | 127 ms | 121 ms | 109 ms |
| 2 | 721 ms | **2,302 ms** | 180 ms | 147 ms | 105 ms |
| 3 | 670 ms | **2,069 ms** | 126 ms | 145 ms | 152 ms |

The first request pays module loading and JIT for the route plus opening pool connections. Requests 2–4 still run about 2× warm speed. Vercel's serverless cold start behaves differently (bundle load, TLS to PgBouncer), so treat these numbers as information only.

## 7. Summary of what the evidence says (facts, not recommendations)

1. **Every authenticated page runs 15–33 SQL statements.** 9 of them are the same shell and auth statements on every page. The pool is 3 wide, so pages pay **about 6–15 effective sequential DB round trips**:
   - `/companies/<id>` pays 14.8, `/applications` 12.8, `/cv/<id>` 9.3, `/` 7.6.
   - At production's 1–5 ms per round trip, that is about 6–75 ms of pure DB wait per page before any query runs slowly.
2. **Request-level duplicates exist but are few.** They show up on 6 of the 13 statement-issuing pages:
   - the global `settings` read up to 3× (`/applications`, `/settings`; 2× on `/library`, `/learning`, `/suggestions`),
   - `user_settings` 2× (`/applications`, `/settings`),
   - `company_suggestions` count 2× (`/suggestions`),
   - `discovery_runs` 2× (`/companies/<id>`).
3. **Planning and parse overhead is 41–77 % of SQL time**, because every statement is unnamed and re-planned. The role-page query plans in about 3.3 ms and misestimates 960 rows as 1.
4. **Locally, render and serialization, not SQL, dominate** the heaviest pages (52–58 ms of 64–71 ms). `/`, `/companies` and `/companies/<id>` ship **90–100 KB RSC / 228–244 KB HTML** for 48 roles or 20 companies:
   - 63.5 KB of roles-table props on `/`,
   - about 4.4 KB per company row on `/companies`.
5. **Client JS**:
   - Shared baseline: 102 KB gzip.
   - `/cv/[id]` 162 KB, `/library` 153 KB and `/settings` 142 KB gzip first load, of which 24 KB gzip is a zod chunk loaded on those three routes.
   - One 8.5 KB gzip CSS file; 37 KB of preloaded fonts.
6. **Polling endpoints are cheap**:
   - `/api/work-status`: 2 statements, 2.2 sequential RTs, 11 ms.
   - `/api/scan-status`: 7 statements, 3.2 RTs, 16 ms.

Housekeeping: the server on :3151 and the latency relays (55420/55430/55435) have been stopped. The `ava_perf_bench` database is left in place, with `log_min_duration_statement = 0` and `log_statement = 'none'` set at database level (the cluster-wide `log_statement = all` was already on).
