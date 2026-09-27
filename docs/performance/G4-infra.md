# G4 · Infrastructure and data layer

**Evidence base.**
- **Fixture.** `ava_perf_infra` is a copy of `ava_perf_bench` (100 accounts, 20 companies, 1,000 postings, 100,000 `user_jobs`, migrated through 0042). I added three layers to it:
  - realistic churn: 60,000 finished tasks over 30 days plus a live backlog, a year of scans for 20 sources, and about 130,000 `job_events`;
  - a catalogue scale step: 980 more companies and sources, and 147,000 more postings, so 148,000 postings in all. The measured account still sees only its own 1,000;
  - 118,000 more scans for the new sources.
- **Statements.** Replayed with their real parameters from `s2/full.jsonl`, which was captured on the branch that became PR #81. `EXPLAIN (ANALYZE, BUFFERS)`, median of 5 runs, `work_mem = 1654kB`, the live Render value.
- **Scripts.** `scratchpad/perf/g4/{populate.sql,claim.sql,ex.cjs,ex2.cjs,ex3.cjs,sweep.cjs,sweep2.cjs}`.
- **Local database.** The local PostgreSQL service was stopped and I started it (`service postgresql start`). `ava_perf_infra` (198 MB) is left in place so the numbers can be reproduced.
- **Labels.** **V** = verified in code or by measurement here. **I** = inferred. **D** = taken from a repository document (cited). No production setting was read or changed.

Numbers quoted from the docs, not re-measured: the worker's 512 MiB cgroup peaked at 466.8 MiB, and at 411.1 MiB at 1 GiB (`docs/CAPACITY-AND-RECOVERY-DRILLS.md`). The live database has 1 GB of disk at 15% used with autoscaling off, and `max_connections=103` (`docs/HOSTED-CAPACITY-2026-09-20.md`).

---

## Checklist

| # | Item | Status | Impact | Effort |
|---|---|---|---|---|
| 1 | `random_page_cost = 1.1` on the database | not done | Roles page query at 1,000 companies: **318 → 20 ms** (V) | S |
| 2 | Index coverage after 0042: no new composite index; audit the unused ones | done (coverage) / not done (audit) | Every hot path is index-driven (V) | S |
| 3 | Per-table autovacuum for `tasks`, `job_events`, `scans`, `ai_calls`, `user_jobs` | not done | Claim buffers **3×** with 8,000 dead tuples, back to 1× after vacuum (V) | S |
| 4 | `ANALYZE` after bulk loads, restores and in plan tests | partial | Removes the stale-plan class seen in `ec0b195` (V/I) | S |
| 5 | PgBouncer: client slots are not the limit; backends are (93 + 26 > 100) | partial | Prevents a "too many clients" outage at about 12 busy web instances (I) | S–M |
| 6 | Prepared statements through PgBouncer (`max_prepared_statements`) | not done (platform unverified) | 2–3 ms planning per heavy statement (V) | M |
| 7 | Role-level parameters: timeouts, `work_mem`, `jit` | partial | Bounds runaway statements; no spills at 1654kB (V) | S |
| 8 | Database plan: leave `basic-256mb` at a stated threshold | not done | Keeps `user_jobs` indexes cached at 1,000 accounts (I) | S |
| 9 | Read replicas: none yet; threshold stated | not applicable yet | none now | — |
| 10 | Worker container: Starter fails its own 70% gate; next step is Standard 2 GB with an explicit heap cap | not done | Removes the cgroup-OOM class (D) | S |
| 11 | Vercel functions: Node 22 pin, `maxDuration` on the PDF and import routes, `after()` for the session touch, pdfkit off the page path | partial | Bounded cost and tail latency; one fire-and-forget write made safe (V/I) | S |
| 12 | Disk: 15 GB with autoscaling; stop keeping 90 days of `raw_snapshot` | not done | Largest disk grower at 1,000 sources, about 1.8 GB (I) | S |
| 13 | Second worker instance: what already works and what breaks | not applicable yet | Throughput and failover (I) | M |

---

### 1. Set `random_page_cost = 1.1` for the AVA database

- **Recommendation.** Tell the planner that random reads cost about the same as sequential ones, which is true on Render's SSD storage with a hot cache. Run `ALTER DATABASE ava SET random_page_cost = 1.1;` once, from `psql` on the direct URL. `ALTER ROLE <user> SET random_page_cost = 1.1` is equivalent if the user does not own the database.
  - The setting is `PGC_USERSET`, so no superuser is needed.
  - It applies to new backends. PgBouncer's server connections recycle on its `server_lifetime` (3600 s by default), so it takes effect within about an hour, or at the next worker restart for direct connections.
- **Mechanism (V).** The roles page's default view filters on two `CASE` expressions: the view (`… end <> 'archived' and decisions.id is null`) and freshness (`… end in ('new','active','closed')`, which is always true when all three are passed).
  - The planner estimates **1 row** where 944 come back. With `random_page_cost = 4` it then joins `companies` and `career_sources` by **nested loop over a sequential scan**, not by primary-key probe.
  - With 20 companies this is invisible (13 ms). At 1,000 companies it costs 944 × 991 rows visited once the account's companies are not at the front of the heap, which in production they will not be.
  - With 1.1, the same estimate chooses `Index Scan using companies_pkey` and `career_sources_pkey`.
- **Measured (V)**, statement #7 (`fetchRolePage`, auto-matched view, limit 50), `ava_perf_infra` at 148,000 postings:

  | setting | #7 roles page | #10 count | #820 pipeline keys | #13 job_events |
  |---|---|---|---|---|
  | `random_page_cost=4` (Render default) | **317.8 ms** | 11.4 ms | 5.1 ms | 2.2 ms |
  | `random_page_cost=1.1` | **20.0 ms** | 5.8 ms | 5.3 ms | 1.5 ms |

  - A sweep of all 96 distinct read statements in the capture, planning plus execution, best of 2 runs: **875.6 ms total at 4 and 177.8 ms at 1.1**.
  - The worst regression is +0.5 ms (#255).
  - With the freshness tautology removed from the SQL and `random_page_cost=4`, #7 still took 296 ms, so the join method is what matters here.
- **Current status.** Not done. Render's default is 4, and nothing in `packages/db/drizzle` or `docs/DEPLOY.md` sets it.
- **Impact.** Keeps the roles page's main query from growing with catalogue size once the catalogue reaches hundreds of companies. That is about 300 ms of server time off LCP on `/` at 1,000 companies, per render and per refresh (V, local).
- **Effort.** S (one statement, plus a line in DEPLOY.md's database section).
- **Risk and guard.** It changes plans everywhere.
  - Guard: before and after, run `scratchpad/perf/g4/sweep2.cjs` against a production-sized clone, and compare `pg_stat_statements` mean times for 24 hours.
  - Revert with `ALTER DATABASE ava RESET random_page_cost`.
  - The query-shape fix that also removes the misestimate belongs to BACKEND: state `user_jobs.in_table and user_jobs.archived_at is null` as plain predicates, and drop the freshness filter when every state is selected.

### 2. Index coverage after migration 0042

- **Recommendation.** Add no composite or partial index for the hot paths: every one is already index-driven. After 14 days in production, audit the unused indexes on the write-heavy tables.
- **Verified plans (V)**, `ava_perf_infra` after `ANALYZE`, at 148,000 postings where relevant:

  | Path | Index used | exec / plan |
  |---|---|---|
  | Roles page `#7` | `user_jobs_table_idx (user_id, …)` → `jobs_pkey` (Memoize), plus `cv_drafts_job_user_idx` | 20 ms at rpc 1.1 (item 1) |
  | Roles count `#10` | `user_jobs_table_idx` → `jobs_pkey` | 5.8 ms |
  | Applications stage counts `#264` / page keys `#820` | `user_jobs_table_idx`, `cv_drafts_user_idx`, `applications_user_job_idx`, `user_jobs_user_id_job_id_pk` (index only) | 0.6 + 2.1 ms plan; 1.9 + 3.0 ms plan |
  | Recent events `#13` (LATERAL per role) | `job_events_shared_job_at_idx` and `job_events_user_job_at_idx`, both `Index Scan Backward`, Limit 6 | 1.7–2.3 ms for 50 roles |
  | Claim, scan lane | `tasks_lane_idx (type, status, priority, run_after, created_at)`; dedupe probe `tasks_dedupe_active_idx` | 1.8 ms exec, 2.3 ms plan |
  | Claim, CV lane plus fairness | `tasks_lane_idx`, `tasks_cv_running_user_idx` | 0.7 ms exec, 0.8 ms plan |
  | Claim, background lane (`type not in …`) | `tasks_status_run_after_idx` (needed: `tasks_lane_idx` cannot serve `not in`) | 0.7 ms |
  | Status strip `#1` / newest scan per source `#541` | `scans_source_completed_idx` (0042), `scans_source_started_idx` | 2.5–5 ms / 0.4 ms |
  | Retention: scans keep-sets at 1,000 sources | `scans_source_started_idx` backward | 146 ms per 5,000-row batch |

  - No statement spilled to disk at `work_mem=1654kB` (0 of 96).
  - The predicate an index must match: `user_jobs_table_idx` is usable for the auto-matched view only when the SQL says `user_id = $1 AND in_table AND archived_at IS NULL` outside the `CASE`. That is a BACKEND rewrite; no new index is needed.
- **Audit (not done).** The fixture scans flagged these with `idx_scan = 0`:
  - `jobs_first_seen_idx` (4.2 MB at 148,000 postings);
  - `jobs_company_status_idx` (1.4 MB);
  - `tasks_scan_run_idx`, which is non-partial and so indexes every task (2.2 MB at 64,000 tasks).

  In production, run `select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) from pg_stat_user_indexes where relname in ('tasks','jobs','job_events','user_jobs') order by idx_scan;`.
  - Drop only what shows 0 there **and** has no code reader (grep first). `job_events_job_idx` shows 0 but serves the `ON DELETE CASCADE` from `jobs`: keep it.
  - If `tasks_scan_run_idx` stays, make it partial so non-scan tasks are not indexed:
    `CREATE INDEX CONCURRENTLY tasks_scan_run_p_idx ON tasks ((payload->>'scanRunId'), status) WHERE payload->>'scanRunId' IS NOT NULL;` then `DROP INDEX CONCURRENTLY tasks_scan_run_idx;`.
    Its readers (`handlers/daily.ts:115`, `scan-summary.ts:71`) use `payload->>'scanRunId' = …` / `in (…)`, which implies `IS NOT NULL`, so the partial predicate matches.
- **Impact.** Coverage: none left to gain. Audit: fewer index writes per task insert or claim. `tasks` carries 13 indexes and every status change is a non-HOT update (I, small).
- **Effort.** S.
- **Risk and guard.** Dropping an index a rare path needs, such as an admin page or a cascade. Guard: `pg_stat_user_indexes` over at least one weekly cycle, plus the `indexes.test.ts` case list, which names each index's reader.

### 3. Per-table autovacuum for the high-churn tables

- **Recommendation.** Ship as migration 0043. `ALTER TABLE … SET` takes a `SHARE UPDATE EXCLUSIVE` lock, so it does not block reads or writes.
  ```sql
  ALTER TABLE tasks      SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 500,
                              autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500);
  ALTER TABLE job_events SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02,
                              autovacuum_vacuum_insert_scale_factor = 0.05);
  ALTER TABLE scans      SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02,
                              autovacuum_vacuum_insert_scale_factor = 0.05);
  ALTER TABLE ai_calls   SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
  ALTER TABLE user_jobs  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
  ```
- **Mechanism.**
  - `tasks` is a queue. Every claim and finish rewrites `status`, which is an indexed column, so the old version's entries stay in the `status = 'queued'` index range until vacuum. With the default scale factor of 0.2 on about 60,000 retained rows, vacuum waits for about 12,000 dead tuples, roughly 3 days of 1,000-company churn.
  - `job_events`, `scans` and `ai_calls` are mostly inserts, pruned hourly. The insert trigger (PG13+) keeps the visibility map current, so the retention and index-only scans stay cheap.
  - `user_jobs` is rewritten on every rescore and gate re-evaluation (`fit_score` is in `user_jobs_table_idx`).
  - The renewal heartbeat is **already HOT**: 1,096 of 1,100 simulated `locked_at` updates. `locked_at` is not indexed, so no `fillfactor` change is needed (V).
- **Measured (V).** Scan-lane claim on `ava_perf_infra` with autovacuum off:
  - clean: 88 shared buffers;
  - after 4,000 tasks cycled queued → running → done (8,008 dead tuples): **277 buffers**;
  - after `VACUUM tasks`: 92.
- **Current status.** Not done: no `autovacuum_*` storage parameter in any migration (grep of `packages/db/drizzle`).
- **Impact.** Claim cost stays flat through the daily fan-out. That matters because every idle slot polls every 3 s (`queue.ts:729`): 11 slots means about 316,000 claims a day on a 0.1-CPU database (I). Statistics stay fresh for the planner (item 4).
- **Effort.** S.
- **Risk and guard.** More frequent vacuums cost I/O on a small instance. At these table sizes each run is seconds (I). Guard: `select relname, last_autovacuum, n_dead_tup from pg_stat_user_tables` on Operations or `psql` after deploy; revert with `ALTER TABLE … RESET (…)`.

### 4. `ANALYZE` after bulk loads, restores and in plan tests

- **Recommendation.** Run `ANALYZE` explicitly, not by waiting for autovacuum, in four places:
  - at the end of the bulk company import action (1,000 URLs in batches of 100, `docs/THOUSAND-COMPANY-READINESS.md`) and after a `reevaluate_gate` run that touched more than 500 jobs: `ANALYZE companies, career_sources, company_subscriptions, user_jobs` (a few hundred ms, no blocking locks);
  - after every `pg_restore` in `scripts/recovery-drill.mjs` and in the managed restore runbook: `vacuumdb --analyze-in-stages`. PG16's `pg_restore` restores **no statistics**, so a restored database plans on defaults until autovacuum reaches it (I; PG18 changes this);
  - in any test that asserts a plan, after its fixture load (`ANALYZE <tables>`).
- **Mechanism (V).** Commit `ec0b195` records the flakiness: the newest-scan plan test failed with a bitmap scan after the web suite filled the database, because the planner chose by whatever statistics it held. The fix, which drops the competing indexes and sets `enable_seqscan = off` (`packages/db/src/indexes.test.ts:24-40`), asks whether the index *can* serve the query, which is the right question for a unit test.
  - On this machine the fixture's `pg_stat_user_tables` counters came back empty after the unclean restart, though `pg_statistic` survived. So "never analyzed" and "stats reset" are both states production can be in after a failover.
- **Current status.**
  - Partial: `scripts/benchmark-users.mjs:149` analyzes; no production path does (grep for `analyze` across `apps/worker/src`, `packages/db/src` and `scripts/`).
  - The recovery drill does not analyze.
- **Impact.** Avoids hours of misplanned queries after an import or restore (I). Removes the flaky plan-test class (V).
- **Effort.** S.
- **Risk and guard.** `ANALYZE` inside a request path would add latency. Run it from the worker after the import task completes, not inside the server action's transaction.

### 5. PgBouncer on Render: the backend ceiling, not the client ceiling

- **Recommendation.** Treat PostgreSQL backends as the budget, and cap the combined peak explicitly:
  - (a) tag clients with `application_name` so the split is measurable. Append `application_name=ava-web` or `application_name=ava-worker` to each `DATABASE_URL`: node-pg reads it from the URL, and PgBouncer tracks `application_name` in transaction mode;
  - (b) alert at **80 backends** (`select count(*) from pg_stat_activity where backend_type = 'client backend'`);
  - (c) keep `WEB_DB_POOL_MAX × peak concurrent web instances ≤ 60`.
- **Settings (D, and V from Render's docs page via search):**
  - `pool_mode = transaction` on port 6432;
  - `default_pool_size` = `max_db_connections` = `max_connections − 10` = **93**;
  - `max_client_conn = 30000`;
  - `client_idle_timeout = 86400` s.
  - Not exposed and therefore unverified: `server_idle_timeout`, which PgBouncer defaults to 600 s, and whether any of these can be changed.
- **The arithmetic (V: pool sizes from `apps/web/lib/db.ts` and `apps/worker/src/env.ts:60`):**
  - **Client slots.** 6 per warm web instance, 6 more for the cron fallback: 6N + 6 ≤ 30,000, so up to about 4,990 instances. Not a constraint.
  - **Backends.** PgBouncer may open up to 93. The worker holds up to `2 × (3 + 8) + 4` = **26 on the direct port**, outside PgBouncer. 93 + 26 = **119 > 100 usable** (103 − 3 superuser-reserved).
  - The worker's pool idles connections out after 30 s (`client.ts`, `idleTimeoutMillis: 30_000`) and reconnects on demand. After a web burst, PgBouncer keeps its server connections open for `server_idle_timeout`. For up to about 10 minutes a worker reconnect, a migration or an operator's `psql` can then fail with `sorry, too many clients already`. A scan failing to connect is recorded as a failed scan, not a closure (the closure rule holds), but CV builds and claims stall.
  - It takes about 67 simultaneous web transactions, for example 12 instances each running 6 statements at once, a plausible 100-session burst (I). Observed live peak: 8 active backends (D).
- **Current status.** Partial. The pooled URL, the pool width and "no startup parameters on 6432" are done (`packages/db/src/client.ts:167`). `application_name`, the alert and a stated cap are not.
- **Impact.** Prevents an outage mode that hits every account at once. No latency change.
- **Effort.** S for (a) and (b). M if a separate web role with `CONNECTION LIMIT 60` is wanted (`CREATE ROLE ava_web LOGIN PASSWORD … CONNECTION LIMIT 60` plus grants). Whether Render lets the default user create roles is unverified: check it before planning on it.
- **Risk and guard.** A role limit makes PgBouncer queue or fail web transactions instead of starving the worker. That is the right side to fail on, because web requests retry and closure detection is untouched. Guard: `WEB_DB_POOL_MAX` stays the fast lever (DEPLOY.md step 5).

### 6. Prepared statements through PgBouncer

- **Recommendation.** First probe whether Render's PgBouncer has `max_prepared_statements > 0` (needs PgBouncer ≥ 1.21):
  - through the 6432 URL, with a pool of 2, run `pool.query({ name: 'probe', text: 'select 1' })` 20 times in separate transactions;
  - `prepared statement "probe" does not exist` means unsupported.
  - If supported, give node-pg `name:` to the four statements whose planning exceeds their execution (below).
  - This is deliberately "later" in BACKEND item 11; the probe itself belongs here.
- **Measured (V)**, planning vs execution: #820 (pipeline keys) 3.0 vs 1.9 ms; #264 (stage counts) 2.1 vs 0.6 ms; #12 2.1 vs 5.1 ms; #7 1.9–2.8 vs 20 ms; the claim 0.8–2.3 vs 0.7–1.8 ms.
- **Current status.** Not done; platform capability unverified (Render's docs page does not state it).
- **Impact.** About 2–5 ms of database CPU per full `/applications` render. On the claim, about half its cost times about 316,000 idle polls a day (I).
- **Effort.** M: named statements in Drizzle need the raw `pg` query objects.
- **Risk and guard.** A generic plan chosen after 5 executions can be worse for skewed parameters such as a large account. Guard: `plan_cache_mode` stays `auto`. Compare `pg_stat_statements` before and after, and remove the `name:` from any statement that regresses.

### 7. Role-level PostgreSQL parameters

- **Recommendation.** Run once on the direct URL:
  ```sql
  ALTER ROLE <user> SET statement_timeout = '30s';                      -- documented; confirm it is live
  ALTER ROLE <user> SET idle_in_transaction_session_timeout = '60s';    -- documented; confirm it is live
  ALTER DATABASE ava SET random_page_cost = 1.1;                        -- item 1
  ALTER DATABASE ava SET jit = off;                                     -- OLTP: never pay JIT compile on a page query
  -- work_mem: leave at Render's 1654kB on basic-256mb
  ```
  - Check the result with `select rolname, rolconfig from pg_roles where rolname = current_user;` and `select setdatabase, setconfig from pg_db_role_setting;`.
- **Mechanism.**
  - Pooled connections send no startup parameters (V, `serverTimeouts()` returns `{}` for 6432). The web's own `statementTimeoutMs: 30_000` and `idleInTransactionTimeoutMs: 30_000` (`apps/web/lib/db.ts`) are therefore silently dropped, and only the role setting bounds the interface.
  - `work_mem`: 0 of 96 captured statements spilled at 1654kB (V). The largest sort is the roles top-N heapsort at 66 kB. Raising it on a 256 MB instance multiplies by sort/hash nodes × backends for no measured gain. Watch `select temp_files, temp_bytes from pg_stat_database where datname = current_database()` instead: `log_temp_files` is superuser-only.
  - `jit`: no captured plan crosses `jit_above_cost` (100,000) today; the largest is about 10,000. A catalogue-wide admin or export query at scale could, and would then pay 50–200 ms to compile (I). Low priority.
  - Do **not** set `idle_session_timeout`: it would kill PgBouncer's idle server connections.
- **Current status.** Partial. The timeouts are written in `docs/DEPLOY.md` (lines 104–117) but applying them to the live role is unverified (`HOSTED-CAPACITY` does not record them). `random_page_cost` and `jit` are not done.
- **Impact.** Reliability: a function the platform kills mid-query no longer leaves its statement holding locks.
- **Effort.** S.
- **Risk and guard.** A 30 s role timeout also applies to an operator's `psql`. DEPLOY.md already says `SET statement_timeout = 0` first for `CREATE INDEX CONCURRENTLY`.

### 8. Database plan and memory

- **Recommendation.** Move the database from `basic-256mb` to `basic-1gb` (shared_buffers about 256 MB) when either signal fires:
  - `select sum(heap_blks_hit)::float / nullif(sum(heap_blks_hit + heap_blks_read), 0) from pg_statio_user_tables` falls below **0.99** over a day;
  - or `pg_total_relation_size('user_jobs') + pg_indexes_size('jobs')` exceeds about 150 MB (≈ 700 accounts at 1,000 views each).

  Before that, a plan change buys nothing: database CPU peaked at 15% and memory at 55% (D).
- **Numbers.** Measured sizes per row (V, fixture, heap plus indexes plus TOAST):
  - `user_jobs` 185 B per view (1M views ≈ 185 MB);
  - `job_events` 259 B;
  - `tasks` 398 B;
  - `jobs` 536 B per posting before real descriptions (item 12).

  `shared_buffers = 64MB`, `effective_cache_size = 192MB` (D).
- **Current status.** Not done: `render.yaml` still says `basic-256mb`, which DEPLOY.md already says is too small at scale.
- **Impact.** Keeps the per-account index probes (item 2) in memory. At 1–5 ms per cold random read, a roles render with 1,000 cold `jobs_pkey` probes would pay seconds (I).
- **Effort.** S: a dashboard change with a short restart.
- **Risk and guard.** The plan change restarts the database, which is an outage of a few minutes. Do it outside the daily run and take a restore point first (DEPLOY checklist).

### 9. Read replicas: none yet

- **Recommendation.** Do not add one. Nothing in AVA today is both heavy enough to offload and safe to read stale.
- **What could go to a replica later, and what never should (I, from the code paths):**
  - **Safe:** Admin › Operations aggregates (`ai_calls`, `http_host_daily`, `worker_events`, `cv_build_steps` medians), `listLargestScanInputs`, the CSV export (`/api/export.csv`, `maxDuration 60`) and learning-page history. All are read-only and tolerate seconds of lag. Per-account ones still carry `userId`: a replica does not relax the account rule, it only changes the host.
  - **Never:**
    - anything the worker reads to reconcile a scan (`missing_scans`, `first_missed_at`, the last successful scan). "Only a successful scan may close a role" depends on reading what the previous scan wrote;
    - the claim and leases;
    - budget reservations;
    - `getCurrentUser()`, since a session is a row and a sign-out must take effect;
    - any render that follows a write. PR #81's "one render per write" re-renders in the action response, which needs read-your-writes.
- **Threshold.** Reconsider when primary CPU is above 60% sustained **and** `pg_stat_statements` shows more than 30% of total time in the "safe" list above, or when Operations pages exceed 1 s p95. Replica lag must be monitored (`pg_last_xact_replay_timestamp()` on the replica), and the web must fall back to the primary when lag exceeds 10 s.
- **Status.** Not applicable. The live database has no replicas (D).
- **Effort.** M: a second Drizzle client, plus routing only the listed queries.
- **Risk.** Stale reads leaking into a post-write render. The guard is the explicit allow-list above, never a default.

### 10. Worker container sizing (Render)

- **Recommendation.** Move the worker from **Starter** (0.5 CPU, 512 MiB) to **Standard** (1 CPU, 2 GB) before the hosted capacity gate or more than 10 active accounts.
  - Set `NODE_OPTIONS=--max-old-space-size=896` there. The V8 abort then comes before the cgroup kill, leaving about 1.1 GB for Chromium, the `tsx`/esbuild overhead and native buffers.
  - Keep `WORKER_CONCURRENCY=3` and `CV_CONCURRENCY=8` until a representative soak shows a peak cgroup use below 70% (1.4 GB). Only then try `WORKER_CONCURRENCY=6` (render.yaml's own rule).
  - Render's instance ladder has no 1 GiB step: Starter 512 MB → Standard 2 GB (I, as of this writing; check the dashboard). The local 1 GiB pass is therefore a lower bound for Standard, not a plan.
- **Memory math per slot (D, V):**
  - **Base process.** 140–168 MB resident when idle, of which about 60 MB is `tsx` plus the esbuild child (DEPLOY.md "The worker runs its TypeScript through tsx"). Heap 37–46 MB at boot. Heap ceiling 259 MB (Node sizes the heap at about half the cgroup).
  - **General slot.** A verification or scan adds 23–53 MB of heap at the task boundary (HOSTED-CAPACITY). A large listing is held as a UTF-16 string plus its parse: a 41 MB board is roughly 80 MB for the string and a multiple of that parsed. One such input does not fit beside two others under a 259 MB heap, which matches the 10-hour restart loop.
  - **Chromium.** One browser (never closed once launched, `browser.ts:117-140`) plus one context (`BROWSER_CONCURRENCY=1`). The cgroup peaked at 466.8 MiB with process RSS 368.3 MiB and 57 MiB of file cache, so about 100 MiB of Chromium and native memory sits outside V8.
  - **CV slot.** Mostly waiting on the model. 50 accounts × 2 CVs through 8 slots peaked at about 90 MB of heap (render.yaml).
  - **Totals.** 512 MiB fails the 70% gate (466.8 > 358.4 MiB). 1 GiB passes it (411.1 < 716.8 MiB).
  - **CPU.** 0.108 CPU at the worst minute (D): CPU is not the constraint, so Standard's 1 CPU is headroom, not the reason.
- **Cheaper levers first, if cost matters (cross-reference BACKEND).** Compile ahead with esbuild to recover about 60 MB (DEPLOY.md calls it "the first lever"). Close the browser after about 5 idle minutes to recover its resident baseline between bursts.
- **Current status.** Not done. The live worker is Starter with `NODE_OPTIONS` unset (D). DEPLOY.md is right to leave the heap flag unset on Starter; on Standard it should be set.
- **Impact.** Removes the unexplained unclean-exit class (cgroup OOM, the leading hypothesis for 06:11 on 20 September).
- **Effort.** S: a dashboard change plus `render.yaml` `plan: standard`. About $25 a month instead of $7.
- **Risk and guard.** A heap cap that is too high reproduces the silent cgroup kill; one that is too low aborts early. Guard: the boot line `worker environment` logs `heapLimitMb`. Alert on unclean exits whose last heap reading was below 85% (the cgroup-OOM signature).

### 11. Vercel function settings

- **Region and tier.** `fra1` is pinned in `apps/web/vercel.json` and confirmed executing in fra1. Standard 1 vCPU / 2 GB with Fluid Compute (D). **Done.** No move to Performance (2 vCPU / 4 GB) is indicated: `/api/health` used 228 MB, and a local 100-session burst peaked at 635 MB resident, back to 254 MB after (D).
- **Node version.** The dashboard shows Node 24.x while `apps/web/package.json` declares `"engines": { "node": "22.x" }` (V) and the worker image runs Node 22. Set the project's Node.js version to 22.x in Vercel settings. The `engines` field only takes effect when the project setting is not overriding it. **Not done** (D: HOSTED-CAPACITY lists it as open drift).
- **`maxDuration`.**
  - `api/cron` 60 and `api/export.csv` 60 are set (V).
  - The PDF and upload routes have none: `api/cv/[id]/pdf`, `api/cv/preview`, `api/applications/[id]/pdf` and `api/cv/library/imports` (V, grep). Under Fluid they inherit the 300 s default.
  - Add `export const maxDuration = 30` to the three PDF routes (a CV renders in about a second, bounded by `cv-render-limit.ts`) and `60` to the library import route (up to 5 MB parsed), so a pathological document costs 30 s of GB-seconds rather than 300.
  - Server actions inherit their page's limit: the `/cv/[id]` page renders a PDF in `recordApplication`, so give that page `export const maxDuration = 30` as well.
- **`after()` for the session touch.** `apps/web/lib/auth.ts:36` fires `void db().update(sessions)…` without awaiting it. On a serverless instance frozen after the response, that write can be lost or finish on the next thaw.
  - Wrap it as `after(() => db().update(sessions)…)`: Next 15's `after` maps to Vercel's `waitUntil`. The pattern is already used in `app/login/actions.ts:96,125`.
  - Hourly per session, so the cost is nil. It is a correctness fix at the platform boundary. **Not done.**
- **Cold start and pdfkit.**
  - `serverExternalPackages` includes `pdfkit`, `pg`, `playwright` and `@anthropic-ai/sdk` (V), so they are loaded from `node_modules` and not bundled.
  - `outputFileTracingIncludes` adds pdfkit's standard fonts only to `/api/cv/[id]/pdf`, `/api/cv/preview` and `/cv/[id]` (V). That is correct: `/api/applications/[id]/pdf` serves stored bytes (V).
  - However, `app/actions/applications.ts:10` and `app/actions/cv.ts:5` import `@/lib/cv-pdf` at module scope. pdfkit, fontkit and `@noble/*` are therefore traced into pages that never render a PDF: the `/applications` page `.nft.json` lists them (V).
  - Change both to `const { renderCvPdf } = await import("@/lib/cv-pdf")` inside the action. That shrinks those functions' packages and removes any chance of module evaluation on a cold start. Local cold first request measured 1.9–2.3 s (A-baseline §6); the pdfkit share of it is unmeasured (I). **Not done** (BACKEND item 12 describes the same import; the trace and size angle is this section's).
- **Effort.** S for each.
- **Risk and guard.** A too-short `maxDuration` cuts off a legitimate large render. The 30 s limit is 10× the render limit, and the smoke test (`pnpm smoke:web`) exercises the PDF download.

### 12. Disk and retention

- **Recommendation.**
  - (a) Set the live database to **15 GB with storage autoscaling on**, and alert at 70%. The live database is 1 GB with autoscaling off (D). `render.yaml`'s `diskSizeGB: 15` does not apply, because the live services are not linked to the blueprint.
  - (b) Add a retention rule that clears old snapshot text but keeps scan rows. Every reader of `raw_snapshot` takes only the newest one per source: `handlers/scan.ts:1055` (last successful) and `handlers/suggest-from-scans.ts:68` (latest `ok/partial` with a snapshot). The interface never selects it (V). Add this rule to `RULES` in `apps/worker/src/maintenance.ts`:
    ```sql
    update scans set raw_snapshot = null where id in (
      select s.id from scans s
      where s.raw_snapshot is not null and s.started_at < now() - interval '7 days'
        and not exists (select 1 from (select id from scans r where r.source_id = s.source_id
                          and r.status in ('ok','partial') and r.raw_snapshot is not null
                          order by r.started_at desc limit 1) keep where keep.id = s.id)
      limit $n)
    ```
- **Growth per posting (I, from measured row sizes).** Snapshots dominate:

  | Data | Estimate | At scale |
  |---|---|---|
  | Posting | ≈ 3 KB compressed description (5 KB of English text through pglz; the fixture's synthetic text compresses to 126 B, so it cannot be measured here) + 0.5 KB row + 0.3 KB across 7 indexes + ≈ 1.3 KB of events (5 × 259 B) | ≈ **5 KB per posting**, ≈ 750 MB at 150,000 |
  | Account view | 185 B | 1M views ≈ 185 MB |
  | Tasks | 30 days × ≈ 2,500 a day × 398 B | ≈ 30 MB |
  | Scans | `raw_snapshot` is gzip + base64 (TOAST cannot compress it further) holding postings metadata and up to 20 KB of each response head (`scan.ts:1018-1026`). At an assumed 20 KB each × 1,000 sources × 90 days | ≈ **1.8 GB**; rule (b) cuts it to ≈ 1,000 × 8 × 20 KB ≈ 160 MB |

  Measure the real snapshot figure first: `select count(*), pg_size_pretty(sum(pg_column_size(raw_snapshot))) from scans;`.
- **Prune job (V, `maintenance.ts`).**
  - Hourly, claimed through a `settings` row (one worker per hour).
  - 5,000 rows per statement, 20 s budget per table, each batch its own statement outside a transaction.
  - Measured: 5,000 `job_events` deleted in 37 ms, and one scans batch in 146 ms at 125,000 scans on 1,000 sources, using `scans_source_started_idx` for the keep-sets. Headroom is well over 10× the insert rate.
  - Deleted space is reused, not returned to the OS. That is fine with autoscaling; `VACUUM FULL` is never needed on this schema.
- **Current status.** (a) is not done (live 1 GB). (b) is not done. The prune job itself is **done**.
- **Impact.** A full disk stops every write, sign-ins included (DEPLOY.md). (b) removes the single largest grower (I).
- **Effort.** S each.
- **Risk and guard.** (b) could clear a snapshot a future feature wants. Keeping the latest successful one per source preserves what closure reuse and suggestions read today, and the `status` and `postings_found` columns stay for history. Add a maintenance test in the existing `maintenance.test.ts` style.

### 13. A second worker instance

- **Already multi-instance safe (V):**
  - claims use `FOR UPDATE SKIP LOCKED` (`queue.ts:191,200`);
  - completion is fenced on owner **and** attempt (`ownedTask`);
  - leases renew every 30 s, and stale recovery is by lease age with a distinct `workerId = RENDER_INSTANCE_ID` (`env.ts:77`, `requeueStale`);
  - the weekly jobs and the daily fan-out serialise on `pg_advisory_xact_lock('ava:weekly-jobs' | 'ava:daily-runs')`;
  - boot gate re-evaluation uses `'ava:gate-reevaluation'`;
  - hourly maintenance and scheduler ticks are claimed through `settings` rows (`scheduler.ts:187`);
  - host pacing and AI budget reservations are shared through PostgreSQL;
  - migrations at boot take a session advisory lock.
  - **The scheduler is therefore not a singleton problem.**
- **What breaks or degrades:**
  1. **Connections.** A second instance adds 26 direct backends: 52 + 93 through PgBouncer against 100 usable (item 5). Halve `CV_CONCURRENCY` per instance, or lower both instances' slots, so that `instances × (2 × slots + 4) ≤ 30`.
  2. **Memory is per instance.** Each runs its own Chromium, and the `verify_company` cap of one is process-local (`DEFAULT_MAX_ACTIVE_BY_TYPE`, HOSTED-CAPACITY says so). Two instances run two verifications at once, which is safe per instance but doubles outbound browser load. `BROWSER_CONCURRENCY` is also per instance.
  3. **Release check.** `worker-release` polls `/healthz`, which reaches one instance behind Render's load balancer. It can report the new commit while the other instance is still old during a rollout (I).
  4. **Cost.** Standard × 2 is about $50 a month.
- **Threshold.** Add a second instance for failover when the RTO (4 h) cannot tolerate a single-instance restart loop. Add one for throughput only when the oldest ready task regularly exceeds its service target with slots saturated. Scale vertically first (item 10).
- **Status.** Not applicable yet: one instance (D).
- **Effort.** M: the connection re-budgeting plus a release check that asks every instance, or reads the heartbeat rows per `workerId` from the database.
- **Risk and guard.** Connection exhaustion. Do not scale beyond one instance until item 5's alert and `application_name` tagging are in.

---

## Cross-references (not covered here)
- BACKEND: rewrite the roles or count `CASE` filters as sargable predicates and drop the tautological freshness filter (items 1–2). Skip the claim's `fair` CTE on non-CV lanes (it scans the CV backlog on every scan-lane claim: 184 buffers, 0.3 ms). Compile the worker ahead of time. Close the idle browser.
- TESTING & MONITORING: `pg_stat_statements`, and alert delivery for the thresholds named here (80 backends, 70% disk, unclean exits, cache hit below 0.99).

Sources for Render PgBouncer defaults: [Render: Connection pooling for Render Postgres](https://render.com/docs/postgresql-connection-pooling) (via search summary; direct fetch was blocked by the egress proxy), [PgBouncer 1.21 prepared statements](https://www.postgresql.org/about/news/pgbouncer-1210-released-now-with-prepared-statements-2735/).
