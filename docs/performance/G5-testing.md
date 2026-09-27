# G5. Automated performance testing and monitoring

Key: **[V]** checked in the repo or the GitHub API on 2026-09-27. **[I]** inferred, not checked. Measured numbers come from A-after.md and D-live-and-writes.md; anything else is labelled estimate.

## What exists today (verified baseline, not recommendations)

| Area | State | Where [V] |
|---|---|---|
| CI | Four parallel jobs. Timings from main run 348 (PR #81 merge): `check` 8m14s (of which `pnpm -r test` 6m49s), `order-independence` 3m54s, `browser-and-smoke` 3m36s (of which `smoke:web` 1m42s), `worker-image` 2m01s. Wall clock 8m17s. **No job measures performance**: nothing checks bundle size, latency, Lighthouse or load. | `.github/workflows/ci.yml`; Actions run 36269891342 |
| Scheduled gate | `operational-status.yml` runs every 15 min: 3 samples, 15 s apart, from the worker's `/status`. It fails on: heap ≥ 0.85 in 2 samples; `db.waiting` > 0 in 2 samples; oldest ready task ≥ 15 min; ready queue ≥ 25 and grew by ≥ 10; ≥ 2 crash recoveries in 1 h; any provider outage group; ≥ 10 overdue companies. The only delivery channel is a failed GitHub Actions run (email to the repo owner). | `scripts/release-checks.mjs:19-31,170-217`, `scripts/verify-operational-status.mjs` |
| Capacity probe | `scripts/benchmark-users.mjs`, run by hand (not in CI). `TARGETS = { readP95Ms: 2000, writeP95Ms: 4000, pollP95Ms: 1000, maxErrors: 0, maxPhaseSeconds: 120 }`. `POLL_CADENCE = { workStatusMs: 10000, scanStatusMs: 30000 }`, a fixed cadence. Unit tests in `benchmark-users.test.mjs` pin that cadence. | `scripts/benchmark-users.mjs:15,23` |
| CV load | `scripts/cv-load.mjs`, run by hand. `TARGETS`: first-slot p95 60 s, request p95 4 s, poll p95 1 s, zero failed builds, holds and leases. | `scripts/cv-load.mjs:59-70` |
| Smoke | `scripts/smoke-web.mjs`: builds, signs in with a disposable admin (`smoke@ava.invalid`, session row plus HMAC cookie), and fetches every page. Checks correctness only; it records no timing. | `scripts/smoke-web.mjs:31-44` |
| Health page | `percentile_cont` p50/p95 for AI calls per call site (`health.ts:133-150`) and for CV build motions (`:183-207`). Also: cost per CV build and per scored role, weekly build cost, 3 drift rates with thresholds (`:246-330`), the governor card, and heap/RSS from the heartbeat. **The heartbeat's `eventLoopLagP99Ms`, `slowQueries` and `db {total,idle,waiting}` are written by the worker but dropped by `readVitals`** (`health.ts:393-407`). Nothing in `apps/web` reads them. | `apps/web/lib/queries/health.ts`, `apps/worker/src/vitals.ts` |
| Worker telemetry | JSON lines with `taskId`/`taskType` via AsyncLocalStorage. `task start` logs `readyWaitMs` and heap; `task done` logs `ms`. The heartbeat every 30 s carries full vitals. `slow_database_query` is logged at ≥ 250 ms with the statement prefix. | `apps/worker/src/log.ts`, `queue.ts:885-909`, `packages/db/src/client.ts:31,192-207` |
| Web RUM | `NavigationMetrics` beacons `{path,durationMs}` (`responseEnd` on the first load, click-to-path-change on client navigations) to `/api/performance`, which only writes a `page_navigation` log line. No LCP, INP or CLS. No sampling. | `apps/web/components/NavigationMetrics.tsx`, `app/api/performance/route.ts` |
| APM / tracing | None. No `instrumentation.ts`, `@vercel/otel`, `@opentelemetry/*`, `@vercel/speed-insights`, `@vercel/analytics` or `web-vitals` anywhere in the workspace. | grep over `apps/`, `packages/`, root `package.json` |
| Query monitoring | `pg_stat_statements` is referenced nowhere in the repo, migrations or docs. Live state on Render is **not verified**: the Render MCP has no workspace selected, and I did not pick one. DEPLOY.md: "No metrics stack … no alerting rules". | `docs/DEPLOY.md:563,667-675` |

## Checklist

### T1. Commit a bundle-budget gate and run it in `browser-and-smoke`
- **Recommendation:** fail the pull request when any route's first-load JS (gzip) grows by more than its budget.
- **Mechanism:** port `scratchpad/perf/a/js.py` to `scripts/bundle-budget.mjs` (Node, `zlib.gzipSync(buf, {level: 9})`).
  - Read `apps/web/.next/app-build-manifest.json` `.pages` and `build-manifest.json` `.rootMainFiles`.
  - For each `…/page`, take the union of root files, `/layout`, `/(app)/layout` (and `/(app)/admin/layout` for admin routes) and the page's own files. Count `.js` only.
  - Compare with `scripts/bundle-budget.json`: `{ "route": maxGzipBytes }`, plus `"*": 115000` for unlisted routes and `"sharedRoot": 104000`.
  - Budgets are measured + ~3 %, rounded (A-after §4):

    | Route | Measured gzip (A-after §4) | Budget |
    |---|---|---|
    | `/cv/[id]` | 133,356 | 138,000 |
    | `/companies/[id]` | 126,236 | 130,000 |
    | `/library` | 125,189 | 129,000 |
    | `/` | 124,031 | 128,000 |
    | `/applications` | 119,214 | 123,000 |
    | `/suggestions` | 116,502 | 120,000 |
    | `/settings` | 113,420 | 117,000 |
    | `/companies` | 113,419 | 117,000 |
    | others | ≤ 111,874 | 115,000 |
    | shared root | 102,550 | 104,000 |

  - Also fail if any chunk over 20 KB gzip newly appears in a first load. This guards the 23.8 KB zod chunk that PR #81 moved out.
  - Print the markdown table to `$GITHUB_STEP_SUMMARY`.
  - Add `scripts/bundle-budget.test.mjs` (picked up by the existing `node --test scripts/*.test.mjs` step). It should use a synthetic two-route manifest and fake chunk files in a temp directory, and assert: the layout-chain union, dedupe of shared chunks, pass under budget, fail over budget, the new-large-chunk rule, and that an unlisted route falls back to `"*"`.
  - CI step, after `pnpm smoke:web` (which has already built `.next`): `- run: node scripts/bundle-budget.mjs apps/web/.next`.
- **Status:** not done [V]. There is no size check in `ci.yml`.
- **Impact:** keeps first-load JS, and with it TBT/INP on mid-range phones, from regressing silently. The budget stops growth; it does not reduce anything. Cost is under 2 s of CI (estimate).
- **Effort:** S.
- **Risk:** a legitimate feature trips the gate. **Guard:** raise the budget in the same PR, so the diff shows the size decision. Build IDs change chunk names, so compare by route, never by file name.

### T2. Lighthouse CI on pull requests, against the CI-built server first and the Vercel preview second
- **Recommendation:** assert LCP, CLS, TBT (the lab proxy for INP) and script transfer size on four representative routes: `/`, `/companies`, `/library` and `/cv/[id]` (the heaviest).
- **Mechanism:** `@lhci/cli@0.14` in a new job, `lighthouse`, that `needs: browser-and-smoke` artifacts or rebuilds with the Next cache.
  - **Primary target: local `next start`**, seeded exactly as `smoke-web.mjs` does. Export `signIn()`/`followCompany()` from it, or add `scripts/perf/seed-lhci.mjs` that inserts a `lhci@ava.invalid` admin, one session and the 100-account fixture shape (T8).
  - Pass the cookie with `--collect.settings.extraHeaders='{"cookie":"ava_session=v2.…"}'`.
  - `lighthouserc.json`:
    ```json
    { "ci": {
      "collect": { "numberOfRuns": 3, "startServerCommand": "pnpm --filter @ava/web start -p 3124",
        "url": ["http://127.0.0.1:3124/", "http://127.0.0.1:3124/companies", "http://127.0.0.1:3124/library", "http://127.0.0.1:3124/cv/${DRAFT_ID}"],
        "settings": { "preset": "desktop", "throttlingMethod": "simulate", "onlyCategories": ["performance"] } },
      "assert": { "assertions": {
        "largest-contentful-paint": ["error", {"maxNumericValue": 2500, "aggregationMethod": "median-run"}],
        "cumulative-layout-shift": ["error", {"maxNumericValue": 0.1}],
        "total-blocking-time": ["error", {"maxNumericValue": 200}],
        "interactive": ["warn", {"maxNumericValue": 3800}],
        "resource-summary:script:size": ["error", {"maxNumericValue": 140000}],
        "server-response-time": ["warn", {"maxNumericValue": 600}] } },
      "upload": { "target": "temporary-public-storage" } } }
    ```
    `resource-summary:script:size` is transfer bytes, so 140 KB covers `/cv/[id]`'s 133 KB gzip. Use a per-URL `assertMatrix` to hold `/` to 130 KB.
  - Run a second config with `"preset": "mobile"` (the default simulated Moto G4, 4× CPU) at `warn` level only until a baseline exists.
  - **Secondary target: the Vercel preview URL**, from the `deployment_status` event (`if: github.event.deployment_status.state == 'success'`, URL from `github.event.deployment_status.environment_url`).
    - Pass `x-vercel-protection-bypass: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}` plus `x-vercel-set-bypass-cookie: true` in `extraHeaders`.
    - This measures real fra1 TTFB, compression and edge behaviour, which the local run cannot.
    - **Only if Preview has its own `DATABASE_URL` and `SESSION_SECRET`.** Neither `vercel.json` nor DEPLOY.md documents a Preview environment [V]. Seeding a session row requires writing to that database, and it must never be production. Otherwise run the preview pass against `/login` only, signed out.
- **Status:** not done [V].
- **Impact:** catches LCP/CLS/TBT regressions before merge. Local p50 render is already 36–73 ms (A-after §1), so LCP is dominated by client JS and paint. The thresholds are the "good" CWV boundaries, and the gate costs about 3 min of CI (estimate).
- **Effort:** M.
- **Risk:** flaky lab numbers on shared runners. **Guard:** 3 runs with `median-run`; TBT/LCP as `error` only on the desktop preset; mobile stays at `warn` until 2 weeks of history exist. The seeded account is deleted in a `finally`, as smoke-web does (`smoke-web.mjs:251`).

### T3. Correct the capacity probe's poll model, then run it weekly in CI
- **Recommendation:** replace the fixed `POLL_CADENCE` with the real backoff rule and a measured refresh rate.
- **Why:** D measured, per tab per minute during a run, 4.8 status polls + 2.8 full refreshes + 1.2 banner polls (≈ 8.8 requests, 74 queries, 56 of them from refreshes). Idle is 0 requests per 70 s, and the pre-scan hour is banner-only at a 60 s cap. `POLL_CADENCE` (10 s / 30 s = 8 status reads per minute) overstates idle traffic, where the truth is 0. Its follow-up renders depend on the stand-in worker's tick, not on the measured 2.8/min.
- **Mechanism:**
  - (a) Import the backoff from the app instead of copying it: `nextPollDelay`, `FIRST_POLL_MS`, `LONGEST_POLL_MS` and `BANNER_FIRST_MS` from `apps/web/lib/polling.ts`, via `tsx` or a small `.mjs` re-export. A tab's next status poll then resets to 10 s on a version change and grows ×1.5 up to 60 s otherwise.
  - (b) Split the daily-window phase into three scenarios, each with its own assertion:
    - `idle`: 0 status polls; assert 0 requests.
    - `pre-scan`: banner only, backing off to 60 s.
    - `run`: backoff-driven status polls plus a `router.refresh()`-shaped GET with the `RSC: 1` header on `/` (Shortlisted, the default view, 23 KB), not `/?view=auto-matched` (80 KB). Add a 10 % share of tabs on Matched.
  - (c) Make the stand-in worker finish one company every 12 s, as D's `run.mjs` did, and add a calibration assertion: `followUpRenders.perTabPerMinute` within 2.3–3.3 and `databaseTransactionsPerPoll` reported.
  - (d) Update `benchmark-users.test.mjs`'s cadence test to assert the backoff sequence (`[10000, 15000, 22500, 33750, 50625, 60000]` without change, reset to 10000 on change) rather than the frozen object.
  - Add a `workflow_dispatch` + `schedule: cron "17 3 * * 1"` workflow that runs it at the default shape against a service Postgres. Keep `TARGETS` and add `refreshP95Ms: 2000`.
- **Status:** partial [V]. The probe exists with thresholds but is manual, and its cadence is the fixed model D flagged.
- **Impact:** the busy-case projection becomes ≈ 880 requests/min and 7,400 queries/min per 100 tabs (D, measured) instead of a figure that under-prices refreshes, which are ¾ of the database work. That is the number INFRA sizes PgBouncer and the pool against.
- **Effort:** M.
- **Risk:** CI runner noise fails the weekly job. **Guard:** the weekly job opens an issue (via the `github-script` action) rather than blocking merges, and thresholds are p95 with `maxErrors: 0` kept strict.

### T4. Keep the Node probe; do not port it to k6
- **Recommendation:** leave `benchmark-users.mjs` and `cv-load.mjs` in Node. Add k6 only for one hosted soak test.
- **Reasoning [V]:**
  - Both scripts seed Postgres directly, forge HMAC cookies, spawn `next start` with `--inspect`, and sample heap over the inspector plus `pg_stat_activity`/`pg_stat_database`.
  - `cv-load` runs the real `requestCv` action and `TaskQueue` in child processes.
  - k6 has no pg driver without the xk6-sql extension, can't spawn processes, and can't import `lib/polling.ts`. A port would lose the fixture assertions and the resource sampler.
- **Where k6 earns its place:** a 30-min soak against the **preview** deployment (T2's bypass header) to measure serverless fan-out, PgBouncer client slots and cold starts. The Node probe states it cannot measure these (`benchmark-users.mjs` `limitations`).
  - `k6 run soak.js` with `scenarios: { tabs: { executor: 'constant-vus', vus: 100, duration: '30m' } }`. Each VU loops: status poll → sleep(backoff) → on version change GET `/` with `RSC: 1`.
  - `thresholds: { 'http_req_duration{kind:poll}': ['p(95)<1000'], 'http_req_duration{kind:refresh}': ['p(95)<2000'], http_req_failed: ['rate<0.001'] }`.
  - Needs a Preview database (see T2).
- **Status:** not applicable today (no hosted test target) [I].
- **Impact:** the first measurement of hosted connection and cold-start headroom (none exists).
- **Effort:** M.
- **Risk:** load on the shared catalogue. **Guard:** run only against a Preview-scoped database, never production.

### T5. Real-user Core Web Vitals: extend the existing beacon, sampled, identifier-free
- **Recommendation:** collect LCP, INP, CLS, TTFB and FCP from real sessions. Prefer a self-hosted `web-vitals` beacon over Vercel Speed Insights, because it reuses the existing route and costs no plan tier.
- **Mechanism:**
  - Replace the body of `NavigationMetrics.tsx` with `web-vitals@5` `onLCP/onINP/onCLS/onTTFB/onFCP(report, { reportAllChanges: false })`. Next's `useReportWebVitals` from `next/web-vitals` is equivalent.
  - Keep the existing `path` normalisation (`/[0-9a-f]{8}-…/ → :id`).
  - Batch into one `navigator.sendBeacon('/api/performance', …)` on `visibilitychange === 'hidden'`.
  - Sample at `Math.random() < 0.25`, decided once per page load. This also resolves D's finding 8: one Edge + Node invocation per navigation today.
  - Payload: `{ route, metric, value, rating, navType, deviceClass: navigator.hardwareConcurrency<=4?'low':'high', effectiveType }`. **No userId, session id, email, IP or full URL**, and no query string, because `view=` and the ids stay out.
  - `/api/performance` keeps its cookie-signature check (no DB round trip). It inserts into a new table: `web_vitals(day date, route text, metric text, bucket smallint, count int, primary key(day,route,metric,bucket))`. Use `insert … on conflict do update set count = web_vitals.count + 1`, with values bucketed into log-scaled bins, so the table holds histograms and no individual events.
  - Retention: delete rows older than 90 days in the existing daily cron.
  - Health reads the p75 per route and metric from the histogram.
  - Speed Insights alternative: `@vercel/speed-insights` `<SpeedInsights sampleRate={0.25} />` in `app/layout.tsx`. This needs the Speed Insights add-on enabled for the project.
- **Status:** partial [V]. A navigation-duration beacon exists, but it goes only to logs, carries no CWV and is unsampled.
- **Impact:** the only field INP/LCP source, which is what Google's CWV assessment actually uses. Beacon invocations fall by 75 % against today (derived from the sample rate).
- **Effort:** S–M.
- **Risk:** a hot upsert row under concurrency. **Guard:** the bucketed key spreads writes, the sample rate caps volume, and the route returns 204 even if the insert fails (wrap it in try/catch). This is a privacy rule, so enforce it in the route test (`app/api/performance/route.test.ts`): a body with any extra key is rejected with 400.

### T6. Show the vitals the worker already reports on Health, and alert on them
- **Recommendation:** read `eventLoopLagP99Ms`, `slowQueries` and `db.{total,idle,waiting}` in `readVitals` (`health.ts:393-407`) and render them on the Background worker card. Add them to `readOperationalSample` (`release-checks.mjs:130-165`) so the 15-min gate can alert on them.
- **Mechanism:**
  - The fields are already in the heartbeat (`vitals.ts:13-18`, written every 30 s by `index.ts:60`) and in `/status`.
  - Keep them optional in both readers, so an older worker still parses.
  - `slowQueries` is cumulative since boot. The gate compares first and last samples, so the delta per 30 s tells a burst from history.
- **Status:** not done [V]. The worker writes the fields; nothing reads them.
- **Impact:** makes event-loop stalls (a 40 MB board parse, a gzip) and pool waits visible without a metrics stack.
- **Effort:** S.
- **Risk:** none (reader-only change). **Guard:** extend `release-checks.test.mjs` with a sample lacking the new fields to show it still passes.

### T7. Alert thresholds, and where each fires
- **Recommendation:** make the list DEPLOY.md §"Alert ownership" asks for concrete. Each alert must arrive somewhere a person sees it; a page someone might open is not enough.
- **Thresholds:**

  | Signal | Warn | Fail | Source | Fires in |
  |---|---|---|---|---|
  | Worker heap fraction | ≥ 0.75 in 2 of 3 samples | ≥ 0.85 in 2 samples (exists) | heartbeat `vitals.heapFraction` | Operational gate [exists] + Render memory notification at 90 % of 512 MB |
  | Event-loop lag p99 (since boot) | ≥ 200 ms | ≥ 1000 ms in 2 samples | `vitals.eventLoopLagP99Ms` (T6) | Operational gate |
  | DB pool waiting (worker) | > 0 in 1 sample | > 0 in 2 samples (exists) | `vitals.db.waiting` | Operational gate [exists] |
  | Postgres active backends | ≥ 60 % of `max_connections` | ≥ 80 % | `select count(*) from pg_stat_activity where state <> 'idle'` | Worker cron (below) → Health + gate |
  | PgBouncer client connections | ≥ 60 % of the plan's client limit | ≥ 80 % | Render Postgres Metrics "Connections (pooled)" [I: the exact metric name is not verified] | Render dashboard alert, if available on the plan; otherwise the worker cron reading `pg_stat_activity where application_name like 'pgbouncer%'` [I] |
  | Oldest ready task | ≥ 5 min | ≥ 15 min (exists) | `/status metrics.oldest_seconds` | Operational gate [exists] |
  | Scan failure rate, daily run | ≥ 10 % of sources | ≥ 25 %, or ≥ 10 overdue companies (exists) | `scans.status <> 'ok'` over `scan_runs` today | Worker cron → Health; overdue already in the gate |
  | Model 429/529 rate | ≥ 5 % of calls in 1 h | ≥ 20 %, or an outage group (exists) | `ai_calls.error` ilike `%429%` or `%overloaded%` [I: the exact error text is not verified] | Worker cron → Health + gate `providerFailures1h` |
  | Slow queries | Δ ≥ 20 per 15 min | Δ ≥ 100 | `vitals.slowQueries` delta | Operational gate warning |
  | Disk | 70 % | 85 % | Render Postgres Metrics | Render notification (DEPLOY.md:489 says nothing alerts on this yet) |

- **Mechanism:**
  - Add a `monitor_sample` task scheduled every 5 min by the existing worker scheduler. It runs the four SQL reads above and writes `settings['internal:monitor']` (the pattern `setInternal` already uses for the heartbeat).
  - Health renders it, and `/status` exposes it, so the existing 15-min GitHub gate enforces it.
  - Delivery: set GitHub notifications for failed workflow runs of `operational-status.yml`, which already exists, to the alert owner. Enable Render service notifications for "deploy failed", "service unhealthy" and "instance restarted", sent to email or Slack (Render dashboard › Notifications).
- **Status:** partial [V]. Seven thresholds exist in `OPERATIONAL_THRESHOLDS`. Event-loop lag, active backends, PgBouncer clients, scan failure rate, model 429 rate and disk have none.
- **Impact:** turns the existing ledgers into alerts, with detection time ≤ 15 min.
- **Effort:** M.
- **Risk:** alert fatigue on deploys. **Guard:** keep the gate's existing 2-sample sustain rule and `deployGraceSeconds`. Warnings print as "attention" and do not fail the run (`operationalWarnings`).

### T8. `pg_stat_statements`: enable it and read it in the CLI and Health
- **Recommendation:** turn on query-level statistics in production, so the shell statement A-after flags (0.8–4.7 ms, "worth watching as follows or scans grow") and the role query (12.5 ms) are tracked by total time in production.
- **Mechanism:**
  - Once, as the database owner: `create extension if not exists pg_stat_statements;`. Render lists it as available, and on managed Postgres `shared_preload_libraries` is preset. Confirm with `select * from pg_available_extensions where name='pg_stat_statements'` [I: not verified live].
  - Ship it as a migration guarded by `do $$ begin create extension if not exists pg_stat_statements; exception when insufficient_privilege then raise notice 'skipped'; end $$;` so local and CI databases without the library still migrate.
  - Read it with `pnpm cli pgstat [--reset]` and an admin-only Health card (`requireAdmin`):
    ```sql
    select queryid, calls, round(total_exec_time::numeric,1) total_ms,
           round(mean_exec_time::numeric,2) mean_ms, round(stddev_exec_time::numeric,2) sd_ms,
           rows, shared_blks_hit, shared_blks_read,
           round(100.0*shared_blks_hit/nullif(shared_blks_hit+shared_blks_read,0),1) hit_pct,
           left(regexp_replace(query,'\s+',' ','g'),160) query
    from pg_stat_statements
    where dbid = (select oid from pg_database where datname = current_database())
    order by total_exec_time desc limit 20;
    ```
  - Call `select pg_stat_statements_reset();` weekly from the T10 job after it has snapshotted the top 20 into a `perf_snapshots` row, so figures are per week.
- **Status:** not done [V] (no reference in the repo). Live extension state is unverified.
- **Impact:** production query cost by total time, replacing local log-parsing (A-after used `log_min_duration_statement=0`). Overhead is about 1–2 % CPU (estimate, commonly cited).
- **Effort:** S.
- **Risk:** query text can contain literals. **Guard:** Drizzle and `pg` send parameters, so text is normalised to `$1` [I]. The card is admin-only, truncated to 160 chars and never logged.

### T9. Distributed tracing: `@vercel/otel` on the web, the OpenTelemetry SDK on the worker, a few spans
- **Recommendation:** add traces only for the three places latency hides: a DB query, a model call and a task. Head-sample at 10 %.
- **Web:**
  - Add `apps/web/instrumentation.ts`: `import { registerOTel } from '@vercel/otel'; export function register() { registerOTel({ serviceName: 'ava-web', traceSampler: 'traceidratio' }) }` with `OTEL_TRACES_SAMPLER_ARG=0.1`.
  - Next 15 auto-instruments route, render and fetch spans.
  - Wrap `pg` with `@opentelemetry/instrumentation-pg`, passed in `registerOTel({ instrumentations: [...] })`, set to `enhancedDatabaseReporting: false` so no parameters are captured.
  - Export to an OTLP endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`), for example Grafana Cloud or Honeycomb free tier, or Vercel's OTel integration.
- **Worker:**
  - `@opentelemetry/sdk-node` + `@opentelemetry/instrumentation-pg` + `@opentelemetry/instrumentation-undici`, started via `node --import ./dist/otel.js`.
  - Add manual spans:
    - `task.run` in `queue.ts` around `runTaskInContext`, with attributes `task.type`, `task.attempt` and `ready_wait_ms`.
    - `model.call` in `packages/ai`, with `gen_ai.request.model`, `call_site`, `input_tokens`, `output_tokens`, `cache_read_tokens` and `status`.
    - `scan.fetch` per source.
  - Put the trace id into log lines via the existing AsyncLocalStorage context.
- **Privacy:** no `user.id`, email or CV text as span attributes; `userId` goes into the payload only, as today.
- **Status:** not done [V].
- **Impact:** splits a slow page into DB wait and render (A-after §3 did this by hand: 45–57 ms render against about 18 ms SQL wall). It also shows model time-to-first-token per call site.
- **Effort:** M.
- **Risk:** cold-start cost and memory on the 512 MB worker. **Guard:** 10 % sampling, BatchSpanProcessor `maxQueueSize: 512`, and ship with `OTEL_SDK_DISABLED=true` as the default until an endpoint is configured. Watch heapFraction (T7) for a week after enabling.

### T10. Weekly re-run of the audit measurements, committed under `scripts/perf/`
- **Recommendation:** make yesterday's audits repeatable, so regressions in statements per page and sequential round trips are caught, not rediscovered.
- **Mechanism:** clean and commit, from `scratchpad/perf/a` and `s2`:
  - `scripts/perf/fixture.mjs`, from `a/seed.mjs`: the 100-account, 20-company, 50-jobs shape. It shares `benchmarkShape()` with `benchmark-users.mjs` and writes `fixture.json` with the cookie and ids.
  - `scripts/perf/pages.mjs`, from `a/bench.mjs`: p50/p95, HTML, gzip and RSC bytes, and statements per request. Drop the log-file parsing and count statements from the `pg_stat_statements` `calls` delta between marks (T8), which removes the `log_min_duration_statement=0` dependency.
  - `scripts/perf/roundtrips.mjs`, from `s2/rt.mjs` + `a/proxy.mjs`: effective sequential round trips at +20 ms per packet.
  - `scripts/perf/bundle.mjs` = T1's script.
  - `scripts/perf/decide.mjs`, from `a/decide.mjs`: requests, bytes and statements per role decision (Playwright).
  - Each script gets a `node --test` unit test of its pure parts (percentile, the RT formula, manifest union).
- A weekly workflow (`cron "23 4 * * 1"`) builds, seeds and runs all five. It compares with `scripts/perf/baseline.json`, holding the A-after figures, for example `/` at 14 statements and 4.4 RTs at pool 6, and `/companies/<id>` at 26 statements and 7.6 RTs. It fails on +1 statement or +1 RT on any page, or on +10 % bytes, and uploads the JSON as an artifact.
- **Status:** not done [V]. The scripts live only in the session scratchpad and hard-code `/home/user/christopher` and `ava_perf_bench`.
- **Impact:** statement and round-trip counts are the stable figures (A-after, Method caveat); ms on shared runners is not. Gating on counts gives a deterministic regression signal.
- **Effort:** M.
- **Risk:** a real feature adds a query. **Guard:** update `baseline.json` in the PR with the reason; the gate asks for a decision, not a revert.

### T11. Record CI's own duration budget
- **Recommendation:** keep the PR wall clock ≤ 10 min as T1, T2 and T10 land. The critical path today is `check`: 8m14s, of which `pnpm -r test` is 6m49s.
- **Mechanism:**
  - T1 goes inside `browser-and-smoke`, which has about 4.5 min of slack against `check`.
  - T2 is a separate parallel job reusing the `.next/cache` key.
  - T3 and T10 are scheduled, not per-PR.
  - Set `timeout-minutes: 12` on the Lighthouse job.
- **Status:** not applicable yet. Timings from run 36269891342 [V].
- **Impact:** no added PR latency from T1; T2 finishes inside `check`'s shadow (estimate).
- **Effort:** S.
- **Risk:** none.

## Not covered here
- Fixing what these tools find: bundle splitting is FRONTEND, query shape is BACKEND, and pool and PgBouncer sizing is INFRA.
