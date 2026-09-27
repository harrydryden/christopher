# A (after). Measured performance after the three implementation streams

Before is the build of `8c2ac58`, the numbers from `A-baseline.md`. After is the build of `fbaa385` on branch `claude/lucid-galileo-o2kwas` (BUILD_ID `N6yXPvBtoL35fNkSa4g_6`). No fixes are proposed here.

## Method

Everything is identical to the baseline unless stated otherwise.

- **Fixture:** the same database `ava_perf_bench` and the same rows. I migrated it to the new head, which adds index migration 0042, then ran `analyze`. Measurements run as load user 1 with the same forged cookie.
- **Server:** `next start -p 3151` with the same env.
  - The web pool resolves to **3 connections**, as before. The URL is a direct local one, so the new `webPoolMax` returns `DIRECT_POOL_MAX = 3`.
  - Production uses the pooled URL, where the new default is **6**. I measured that separately with `WEB_DB_POOL_MAX=6` (the last two columns of table 2).
- **Requests:** 10 requests per path, first 2 discarded, n = 8. HTML, then `RSC: 1`.
- **SQL:** counted per request from the Postgres log between `MARK` statements, as before.
- **Round trips:** the same relay (`a/proxy.mjs`). "Effective sequential RTs" = (p50 at +20 ms per round trip − p50 at +0) / 20.
- **Logging:** the cluster-wide statement logging was already reset. I set `log_min_duration_statement = 0` at database level only and reset it at the end (see Housekeeping).
- **Caveat:** the host is a shared 4-vCPU machine and other audit runs were active. Local p50 wanders ±15–25 % between runs. Statement counts, round-trip counts and bytes are the stable figures; small ms deltas are not.

## 1. Before → after per page: time and payload (load user 1, warm, n=8, pool 3, local DB)

| path | p50 ms | p95 ms | HTML B | HTML gzip B | RSC B | RSC p50 ms |
|---|---|---|---|---|---|---|
| `/` | 62.7 → 64.1 | 166.9 → 83.4 | 243,984 → 243,479 | 22,206 → 22,117 | 90,824 → 90,832 | 46.0 → 42.7 |
| `/?view=auto-matched` | 64.9 → 60.3 | 93.6 → 66.8 | 244,056 → 243,551 | 22,240 → 22,151 | 90,852 → 90,860 | 42.7 → 39.5 |
| `/companies` | 71.9 → 68.1 | 78.6 → 73.9 | 233,088 → 231,657 | 18,524 → 18,416 | 99,116 → 99,116 | 35.1 → 32.3 |
| `/companies?tab=discover` | 57.9 → 57.7 | 136.4 → 70.4 | 233,132 → 231,701 | 18,551 → 18,442 | 99,139 → 99,139 | 33.6 → 34.1 |
| `/companies/<id>` | 68.4 → 57.8 | 82.0 → 68.9 | 227,967 → 227,165 | 20,532 → 20,519 | 92,693 → **93,473** | 37.7 → 36.7 |
| `/applications` | 45.5 → 47.0 | 51.8 → 53.3 | 86,680 → 85,799 | 11,504 → 11,414 | 28,251 → 28,251 | 38.3 → 36.4 |
| `/library` | 36.7 → 36.2 | 46.5 → 41.5 | 73,555 → 73,268 | 11,243 → 11,207 | 26,555 → 26,362 | 19.7 → 19.9 |
| `/cv` (307) | 6.6 → 7.4 | 7.2 → 8.2 | 0 → 0 | – | 0 → 0 | 6.0 → 6.5 |
| `/cv/<draftId>` | 36.5 → **41.9** | 43.3 → **56.4** | 58,481 → 58,285 | 10,488 → 10,529 | 22,201 → 22,077 | 21.4 → 22.4 |
| `/suggestions` | 30.3 → **34.9** | 32.6 → **42.2** | 35,093 → 35,105 | 7,344 → 7,351 | 15,993 → 16,003 | 18.3 → 19.5 |
| `/settings` | 31.9 → 33.9 | 38.9 → 39.6 | 63,557 → 63,153 | 11,382 → 11,323 | 23,958 → 23,768 | 21.8 → 19.3 |
| `/learning` | 46.3 → **51.6** | 53.2 → **61.7** | 101,038 → 101,084 | 12,228 → 12,225 | 46,067 → 46,069 | 26.9 → 24.3 |
| `/health` | 28.1 → **33.6** | 33.7 → **39.2** | 34,624 → 34,920 | 7,012 → 7,023 | 15,670 → 15,670 | 18.7 → 21.5 |
| `/account` | 25.3 → 24.8 | 34.3 → 32.5 | 38,107 → 38,110 | 7,567 → 7,567 | 16,360 → 16,362 | 16.7 → 16.6 |
| `/api/work-status?scope=company` | 10.9 → 11.2 | 13.6 → 18.8 | 61 → 61 | – | – | – |
| `/api/scan-status` | 15.7 → 13.0 | 18.4 → 14.7 | 149 → 149 | – | – | – |

**The bold p50 increases are host noise, not regressions.** The same after-build, run through the relay at +0 ms immediately afterwards, gave these p50s. Before-build relay +0 figures from the baseline session are in brackets.

| path | after, relay +0 ms | before, relay +0 ms |
|---|---|---|
| `/cv/<draftId>` | 37.4 | 39.1 |
| `/suggestions` | 26.7 | 29.3 |
| `/learning` | 41.7 | 42.0 |
| `/health` | 29.8 | 30.8 |

Every one of these is equal to or faster than before. Each of those pages also issues 4–7 fewer statements (table 2).

**Payload bytes are essentially unchanged.**
- HTML shrank by 0.1–1.4 KB on most pages. `/health` grew by 296 B and `/learning` by 46 B.
- RSC is flat, except `/companies/<id>`, which grew by **+780 B (+0.8 %)**.
- The large-payload items from the baseline were not in scope: 63.5 KB of roles-table props on `/`, and about 4.4 KB per company row on `/companies`.

## 2. Before → after: SQL statements, duplicates and sequential round trips

| path | statements / request | exact duplicate executions | SQL ms sum | p50 @ +20 ms/RT (pool 3) | **effective sequential RTs (pool 3)** | p50 @ +20 ms/RT, **pool 6** (production default) | effective RTs, pool 6 |
|---|---|---|---|---|---|---|---|
| `/` | 20 → **14** | 0 → 0 | 31.3 → 25.5 | 243.7 → 198.0 | 7.6 → **6.5** | 158.7 | **4.4** |
| `/?view=auto-matched` | 20 → **14** | 0 → 0 | 30.9 → 24.4 | 233.9 → 188.6 | 7.7 → **6.1** | 139.9 | **3.8** |
| `/companies` | 18 → **14** | 0 → 0 | 9.8 → 9.3 | 209.9 → 181.6 | 5.8 → **5.8** | 138.4 | **3.5** |
| `/companies?tab=discover` | 18 → **14** | 0 → 0 | 8.9 → 9.5 | 207.0 → 178.9 | 6.6 → **5.9** | 137.5 | **3.9** |
| `/companies/<id>` | 33 → **26** | 1 → **0** | 26.6 → 19.1 | 377.6 → 280.5 | 14.8 → **10.9** | 211.6 | **7.6** |
| `/applications` | 25 → **18** | 3 → **0** | 19.8 → 19.4 | 325.8 → 212.7 | 12.8 → **8.1** | 172.7 | **5.9** |
| `/library` | 17 → **12** | 1 → **0** | 6.8 → 5.3 | 185.4 → 133.0 | 6.9 → **4.7** | 110.7 | **3.8** |
| `/cv` (307) | 0 → 0 | – | 0 | 10.5 → 7.6 | 0.1 → 0.0 | 7.3 | 0.0 |
| `/cv/<draftId>` | 18 → **13** | 0 → 0 | 8.3 → 7.1 | 224.3 → 135.0 | 9.3 → **4.9** | 112.3 | **3.7** |
| `/suggestions` | 16 → **11** | 2 → **0** | 6.8 → 7.2 | 151.2 → 123.9 | 6.1 → **4.9** | 83.5 | **2.7** |
| `/settings` | 15 → **8** | 3 → **0** | 5.7 → 5.4 | 154.2 → 107.6 | 5.9 → **3.8** | 92.1 | **3.0** |
| `/learning` | 17 → **12** | 1 → **0** | 6.5 → 6.2 | 171.2 → 126.0 | 6.5 → **4.2** | 99.0 | **2.9** |
| `/health` | 16 → **12** | 0 → 0 | 9.2 → 8.8 | 156.4 → 127.2 | 6.3 → **4.9** | 85.5 | **2.8** |
| `/account` | 10 → **6** | 0 → 0 | 5.0 → 4.0 | 111.0 → 79.9 | 4.2 → **2.7** | 64.3 | **1.9** |
| `/api/work-status?scope=company` | 2 → 2 | 0 → 0 | 1.2 → 1.2 | 55.4 → 53.9 | 2.2 → 2.1 | 54.6 | 2.0 |
| `/api/scan-status` | 7 → **3** | 0 → 0 | 3.4 → 2.6 | 77.7 → 55.4 | 3.2 → **2.1** | 56.1 | 2.1 |

Summary of table 2:
- **Statements are down 4–7 per page (21–47 %)** on every authenticated page.
- **Request-level duplicates are gone.** Before there were 11 extra executions across 6 pages; after there are 0 on every page.
- **Sequential round trips at the same pool width fell by 0–4.9 per page.** The biggest falls are `/cv/<id>` (9.3 → 4.9), `/applications` (12.8 → 8.1) and `/companies/<id>` (14.8 → 10.9).
  - `/companies` did not change (5.8 → 5.8) even though it issues 4 fewer statements.
- **The production-shape figure (pool 6) is lower again.** For example, `/` goes from 7.6 before to 4.4 after, and `/companies/<id>` from 14.8 to 7.6. At 1–5 ms per round trip that saves about 3–7 ms on `/` and about 7–36 ms on `/companies/<id>`.

**Statements shared by every authenticated page fell from 9 to 5:**
1. `sessions` (auth),
2. global `settings`,
3. a new combined shell statement `select ( select max(latest.at) from company_subscriptions cs join career_sources src … ) …`,
4. the subscriptions/companies count,
5. the model budget query.

The combined statement replaces the latest scan run, `max(scans.finished_at)`, the two per-user counts and so on. `users.role/email_verified_at` now also carries `user_settings` as a JSON sub-select.

**Slowest statement per request, after:**
- The role-page query is still the slowest on `/`: 12.5 ms (13.3 on auto-matched), against 19.9 and 13.7 before.
- On `/companies/<id>`, `/library`, `/cv/<id>`, `/suggestions`, `/settings`, `/learning`, `/health`, `/account` and `/api/scan-status`, the slowest is now **the new combined shell statement**: 0.9–4.7 ms per execution (median about 0.8–1.5 ms). Before, the slowest on those pages was the role-stage summary at about 1 ms.
  - The new statement is 1 round trip in place of several, but it is individually more expensive to run.
  - In the 20-request profile of `/` it costs parse 0.36 + bind 1.01 + execute 0.94 ≈ 2.3 ms per request.

## 3. Render cost breakdown (20 requests, 18 counted, pool 3, local)

| path | p50 ms (before → after) | p95 | statements | SQL sum (all conns) | SQL exec only | SQL wall (union) | first-to-last SQL span | rest = render/compute | statements per connection |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 71.0 → 72.8 | 92.0 → 103.2 | 20 → 14 | 34.5 → 27.9 | 20.3 → 15.3 | 19.1 → 17.9 | 37.0 → 32.1 | 51.9 → 54.9 | 5/7/8 → 3/5/6 |
| `/companies` | 63.6 → 62.5 | 86.4 → 88.0 | 18 → 14 | 10.3 → 9.1 | 3.1 → 2.5 | 5.9 → 5.5 | 16.2 → 16.2 | 57.7 → 57.0 | 5/5/8 → 3/4/7 |
| `/companies/<id>` | 65.0 → 57.7 | 82.6 → 87.9 | 33 → 26 | 21.6 → 19.4 | 5.0 → 4.3 | 11.9 → 12.2 | 32.4 → 30.4 | 53.2 → 45.5 | 10/14/9 → 10/10/6 |

Locally, render and serialization still take 45–57 ms of these pages and did not materially change. That is consistent with the payload bytes being flat. The SQL gains show up in round trips, not in local wall time.

## 4. Client JS per route (first-load, gzip level 9; `polyfills` nomodule and pages-router `framework`/`main` excluded)

| route | first-load raw (before → after) | first-load gzip (before → after) | route-specific gzip (before → after) |
|---|---|---|---|
| `/cv/[id]` | 545,750 → 441,448 | **162,161 → 133,356 (−28.8 KB)** | 52,109 → 23,156 |
| `/library` | 517,319 → 417,730 | **152,970 → 125,189 (−27.8 KB)** | 42,918 → 14,989 |
| `/settings` | 480,654 → 379,229 | **142,391 → 113,420 (−29.0 KB)** | 32,339 → 3,220 |
| `/companies/[id]` | 417,128 → 418,622 | 125,570 → 126,236 (**+666 B**) | 15,518 → 16,036 |
| `/` | 411,548 → 412,988 | 123,394 → 124,031 (**+637 B**) | 13,342 → 13,831 |
| `/applications` | 395,259 → 395,467 | 119,046 → 119,214 (+168 B) | 8,994 → 9,014 |
| `/suggestions` | 388,717 → 389,372 | 116,217 → 116,502 (+285 B) | 6,165 → 6,302 |
| `/companies` | 377,352 → 377,518 | 113,275 → 113,419 (+144 B) | 3,223 → 3,219 |
| `/learning` | 375,071 → 375,247 | 111,726 → 111,874 (+148 B) | 1,674 → 1,674 |
| `/account` | 371,933 → 372,109 | 110,976 → 111,124 (+148 B) | 924 → 924 |
| `/health` | 370,281 → 370,457 | 110,216 → 110,364 (+148 B) | 164 → 164 |
| `/cv/library` | 370,318 → 370,499 | 110,232 → 110,385 | 180 → 185 |
| admin routes | +150–180 B each | +150–180 B each | unchanged |
| auth pages | 106,295 → 106,443 (+148 B) | | 3,572 → 3,572 |
| shared root | 350,700 → 350,876 | 102,402 → 102,550 (+148 B) | – |

- **The zod chunk (86,614 B raw / 23,798 B gzip) is no longer in any first load.** It is now the async chunk `9269.5f56…js`, loaded on demand.
- A new async chunk `9489.8fe7…js` appeared (11,268 / 4,017 B).
- The chunk shared by the roles-table routes (`/`, `/companies/[id]`) grew from 32,661 B to 33,946 B raw (+497 B gzip); it was `482-…js` and is now `2328-…js`.
- The total across all client chunks is 62 files / 1,149,713 B before and 68 files / 1,165,145 B after.
- CSS is unchanged at 41,191 B raw / 8,530 B gzip.

## 5. Interaction: one role decision (new measurement)

**Method.** Playwright Chromium (`/opt/pw-browsers`) with the forged load-user-1 cookie against `/?view=auto-matched`, the same page and fixture for both builds.
- Shortlist: press `a` on the first row, then Enter on the empty reason box.
- Dismiss: press `s`, fill "Wrong seniority", then Enter.
- Requests are counted from `page.on('request')` from Enter until network idle + 2 s.
- SQL statements are counted from the log over the same window: execute and simple-query lines, shown with BEGIN/COMMIT removed.
- "Row gone" is the time from Enter until the row's element detaches. It includes Playwright's polling granularity, a few ms.
- **Before** used the exported old build at `scratchpad/perf/s2/base`. Its `.ts`/`.tsx` sources in `apps/web` and `packages` are byte-identical to `8c2ac58`. It was served on the same port and database.

| | before (8c2ac58) | after (fbaa385) |
|---|---|---|
| Requests per shortlist (5 runs) | **2**: Server Action `POST /?view=auto-matched`, then `GET …&_rsc` refresh | **1**: the Server Action `POST` only |
| Bytes per shortlist | **185,6xx B** (92,828 + 92,812) | **92,856 B** |
| SQL statements per shortlist (excl. BEGIN/COMMIT) | **52–53** (54–55 incl.) | **26–27** (28–29 incl.) |
| Row gone after Enter | **93–129 ms** (median 105) | **24–30 ms** (median 25) |
| Network settled after Enter | 128–216 ms | 97–115 ms |
| Dismiss with reason (3 runs): requests / SQL / row gone | 2 / 53–54 / 96–97 ms | 1 / 27 / 20–29 ms |

This reproduces D's "2 requests, 160 KB, 52 queries" on this fixture. The bytes are higher here because this fixture's `/` payload is larger (92.8 KB per render against 80 KB). After the change, a decision costs one request, half the bytes and half the statements.

The row now leaves optimistically, before the response. The 24–30 ms is Playwright round trip plus React commit, independent of server time. Some runs recorded 0 bytes for a response because the body was released before Playwright read it. Byte figures use the runs that captured both bodies.

## 6. Regressions (a page slower or bigger than before)

| item | before → after | assessment |
|---|---|---|
| `/companies/<id>` RSC payload | 92,693 → 93,473 B (+780 B, +0.8 %) | real, small |
| `/health` HTML | 34,624 → 34,920 B (+296 B) | real, small |
| `/` and `/companies/[id]` first-load JS | +637 B and +666 B gzip | real, small; the roles-table chunk grew |
| All other routes' first-load JS | +144–180 B gzip | real, small; the shared root grew by 148 B |
| Slowest single statement on 9 of 16 paths is now the combined shell statement | about 1 ms (role-stage summary) → 0.8–4.7 ms per execution | real per-statement cost. It is outweighed by removing 4 statements and 1–2 round trips from every page. Worth watching as follows or scans grow. |
| `/cv/<id>`, `/suggestions`, `/learning`, `/health` local p50 +4.6–5.5 ms | – | **not reproduced.** The relay +0 runs of the same build show equal or faster p50, and statements are down 4–5 on each. This is host noise. |
| `/api/work-status` p95 13.6 → 18.8 ms | – | noise: a single slow sample among n=8, with the same 2 statements and 2 round trips |

No page issues more statements or more sequential round trips than before.

## Housekeeping

- The server on :3151 (new build, then the old build for section 5) and the relays on 55420/55430 are stopped.
- `alter database ava_perf_bench reset log_min_duration_statement` and `reset log_statement` are done. Both now read `default` (−1 / none).
- `/var/log/postgresql/postgresql-16-main.log` is **83,816,949 B** at the end. It was 38,178,201 B when I started this run.
- `ava_perf_bench` is left in place. Load user 1 now carries the decisions made in section 5: 8 more per build.
- Raw data: `scratchpad/perf/a/`
  - `summary-after*.json`, `raw-after*.json`
  - `decide-{before,after}{,-skip}.jsonl`
  - `js-after.txt`
  - `decide.mjs`
