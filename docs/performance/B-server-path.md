# B: server render path audit (apps/web)

Scope: every page under `app/(app)/**`, its layout, loading and error files, the auth layer, `lib/queries/*`,
the `pg` pool and server actions' revalidation. Read-only; no server started.

## How this was measured

- **Query capture.** `scratchpad/perf/b/capture.ts` imports the real query functions under `tsx`, calls each
  page's data functions against `ava_perf_bench` (100 accounts × 20 companies × 50 jobs, 1,000 `user_jobs` per
  account), and records every statement and its duration by hooking `pg.Client.prototype.query`. Second pass
  (warm) is quoted. `React.cache` is a passthrough outside a React server render, so the capture shows
  statements before per-request dedupe; the counts below account for the dedupe that does happen in a render.
- **EXPLAIN (ANALYZE, BUFFERS).** `scratchpad/perf/b/explain.cjs` replays captured statements with their real
  parameters. Growth tests use `ava_perf_b`, a clone of `ava_perf_bench` with `scans` inflated to 7,560 rows
  (about a year for 20 sources) and `ANALYZE`d.
- **Pool simulation.** `scratchpad/perf/b/poolsim.ts` replays the roles page's real statement DAG (session
  lookup, layout banner and Health count, the page's streamed parts and `RoleWorkspace`) with the pool size
  overridden and a fixed delay added before each result is released (the connection is held for it, as it is
  for a network round trip). 10 measured iterations after 5 warm-up, median.
- Localhost latency is ~0.05 ms, so every "ms" from the capture/EXPLAIN is database time only; production
  adds one Vercel fra1 → Render PgBouncer round trip (r) per sequential step. Audit A and C own real timings; I quote
  gains as round trips (RT) saved and in ms at r = 2 ms and r = 5 ms.

Everything not so labelled is **inferred** from reading code.

## Ranked findings

| # | Finding | Where | Measured / inferred | Estimated gain | Risk | Effort |
|---|---|---|---|---|---|---|
| 1 | Every triage action renders the whole page twice: `revalidatePath` makes the action response carry a fresh render, then the client calls `router.refresh()` for a second one | `components/RolesTable.tsx:176,268,288`; `app/actions/decisions.ts:105-110`; also SuggestionsStrip, SuggestionDeck, FollowCompanyButton, RefreshCompanyButton, ApplicationsTable, LibraryImportForm | Inferred, mechanism confirmed in `next/dist/server/app-render/action-handler.js:773,857` (`skipFlight: !workStore.pathWasRevalidated`) | One full server render per click saved: on `/` about 22 statements and the whole RSC payload, ≈ 45–70 ms server time at bench scale (pool sim), on the most frequent write in the product | Low | S |
| 2 | Pool of 3 connections serves ~22 statements per full render of `/` (25 on Applications, ~33 on a company page); non-critical streamed parts queue in front of the main table | `lib/db.ts:12`, `packages/db/src/client.ts:180-191` | **Measured** (pool sim) | `/` time to main content: r=5 ms 70.4 → 54.0 (pool 6) → 47.6 ms (pool 10); r=2 ms 44.3 → 37.1 ms (pool 10); r=0 no change. Larger again under Fluid concurrency (inferred) | Medium (PgBouncer client limit: verify) | S |
| 3 | `lastCompletedScanAt` (in the layout banner, so every full render of every page) and the companies list's "last scan" hash-join every row of `scans` for the whole catalogue | `lib/queries/scan-strip.ts:15-29`; `lib/queries/companies.ts:109-118` (same shape in `listCatalogue` :630-635) | **Measured** | 7,560 scans: banner query 3.05 → 0.28 ms, companies list 6.45 → 0.31 ms with a per-source LATERAL; grows with catalogue × 90-day retention, not with the account | Low | S |
| 4 | Layout fixed cost is 8 statements per full render (banner 6 + Health count 2), plus `Setup` 4 on `/`; each is a separate pool checkout for a tiny scalar | `lib/scan-status.ts:53-60`; `lib/queries/health.ts:1223-1246`; `lib/queries/setup.ts:48-65` | Measured count (capture); gain inferred | 12 → 3 checkouts per full render of `/`, ≈ 3–4 fewer pool waves at pool 3 (≈ 10–20 ms at r=5 ms); multiplies with #1 and AutoRefresh refreshes | Low | M |
| 5 | Roles page: the count query drags in `companies`, `career_sources` and the whole 60-column select list; the landing URL `/` (no `view`) waits for the tab counts before it starts the page read | `lib/queries/jobs.ts:738-741`; `components/RoleWorkspace.tsx:34-35` | **Measured** (count), inferred (RT) | Count 7.5 → 2.1 ms at 1,000 roles; one RT saved on `/` | Low | S |
| 6 | Company page: everything is sequential behind one `Promise.all` of 14 reads, and `RoleWorkspace` (itself 3–4 RT deep) only starts after all 14 finish; discovery run read twice with its unused `log` JSONB | `app/(app)/companies/[id]/page.tsx:106-128,330`; `lib/queries/companies.ts:236-244,386` | Inferred | ≈ 3–4 RT and 5+ pool waves overlapped; one duplicate wide read gone | Low | M |
| 7 | Applications page is ~9 RT deep: counts then page keys (both evaluate the full pipeline index), then hydration, then quotes, and the quote runs settings → Library → description sequentially, reads settings twice and fetches a 30 KB description it never uses | `lib/queries/applications.ts:620-653,676-691`; `lib/cv-quote.ts:259-303`; `app/(app)/applications/page.tsx:53-70` | **Measured** (duplicates, index cost), inferred (RT) | ≈ 4 RT saved; index evaluated once (4.9 + 5.5 ms → ≈ 6 ms); 2 duplicate statements and ≤ 30 KB transfer gone | Low | M |
| 8 | CV page is 6–7 RT deep; `dailyCvVersions` probes `to_regclass` on every call | `app/(app)/cv/[id]/page.tsx:74-116,164`; `lib/queries/cv.ts:95-102` | Inferred | 3–4 RT per render (and per CvBuildLive refresh during a build) | Low | S |
| 9 | Smaller sequential awaits: Companies (count before list), Library (prefs and imports wait for the Library), Suggestions (two waves), admin catalogue (four waves) | `companies/page.tsx:46-48`; `library/page.tsx:27-33`; `suggestions/page.tsx:111-121`; `admin/catalogue/page.tsx:24-27` | Inferred | 1 RT each | Low | S |
| 10 | Shared, non-account reads re-queried on every full render: `getSystemSettings`, `getLatestScanRun` | `lib/settings.ts:20`; `lib/queries/companies.ts:292-297` | Inferred | 2 statements per full render | Low–medium (staleness) | S |
| 11 | Big statements are re-planned on every request: 1.0–2.5 ms planning each for the role/pipeline queries, no prepared statements through transaction-mode PgBouncer | EXPLAIN `Planning Time` | **Measured** | ≈ 5–8 ms DB CPU per `/` render | Medium | L (later) |
| 12 | `pdfkit` is referenced from the server bundles of `/`, `/settings`, `/library`, `/cv/[id]`, `/applications`, `/companies/[id]` through server-action modules that import `@/lib/cv-pdf` at module scope | `app/actions/cv.ts:5`, `app/actions/applications.ts:10`; `.next/server/app/(app)/page.js` has `a.exports=import("pdfkit")` | Inferred (build output read, cold load not profiled) | Cold start only, size unknown: verify before acting | Low | S |

## Details

### 1. Double render per action (do first)
**Now.** `decide()` saves, calls `revalidateDecided()` (four `revalidatePath`s) and returns `ok()`. In Next 15.5 any
revalidation inside an action sets `pathWasRevalidated`, and the action response then carries a full re-render
of the current page (`action-handler.js:773/857`). `RolesTable.submitDecision` then calls `router.refresh()`
(`RolesTable.tsx:268`), which renders the same page again: layout banner, Health count, setup, suggestions,
counts, page, events (≈ 22 statements). The same pattern is in undo (`:288`), bulk actions (`:176`),
`SuggestionsStrip`, `SuggestionDeck`, `FollowCompanyButton`, `RefreshCompanyButton`, `ApplicationsTable`
(`manageRoleCv` revalidates `"/", "layout"`) and `LibraryImportForm`. Every one of those actions revalidates.
**Change.** Delete the `router.refresh()` that follows a successful call to an action that revalidates; keep the
optimistic `removedIds` and notice logic. The action's own response already replaces the tree in the same
transition. Where the action returns early without revalidating (`fail()`), the client already returns before
refreshing, so nothing changes there.
**Verify.** `fetchRolePage` logs `{"event":"role_page"}` once per render: one decision logs two lines today and
should log one. In the browser, one POST and no follow-up `?_rsc` GET per click. Existing RolesTable tests should
be checked for an asserted `refresh` call.

### 2. Pool size on the pooled endpoint
**Now.** `db()` creates one `pg.Pool` per instance with `max: 3` (`lib/db.ts:12`), a figure that dates from the
direct endpoint (`docs/DEPLOY.md:84-93` does the arithmetic for 5432). On 6432 an instance's connections are
PgBouncer clients that hold no backend while idle. A full render of `/` issues about 22 statements, 15 of them at
the instant the session resolves (banner 6, Health 2, WorkNotice 1, setup 4, filter suggestions 1-2, the counts),
and the counts query that the main table waits for sits behind them in the queue. Under Vercel Fluid compute one
instance serves concurrent requests from one pool, which makes this worse (inferred).
**Measured** (pool sim, real statements, `ava_perf_b`):

| pool | r = 0 | r = 2 ms | r = 5 ms |
|---|---|---|---|
| 3 | 35.2 ms | 44.3 ms | 70.4 ms |
| 6 | 38.1 ms | 44.0 ms | 54.0 ms |
| 10 | 34.7 ms | 37.1 ms | 47.6 ms |

**Change.** In `lib/db.ts`, `max: isRenderPooledUrl(url) ? 8 : 3`, and a longer `idleTimeoutMillis` (say 120 s)
for the pooled case so a warm but quiet instance does not pay TLS and PgBouncer auth again on each visit.
Consider `attachDatabasePool(pool)` from `@vercel/functions` so idle clients close before an instance suspends.
Update DEPLOY.md's table. The admin Operations page's hand-batching into groups of eight (`admin/health/page.tsx:59-89`)
can then be revisited.
**Risk.** Render's PgBouncer `max_client_conn` and `default_pool_size`: check them (`SHOW CONFIG` is not available
on Render; the dashboard or support states them). Backends stay bounded by PgBouncer, so the database side is
unchanged; the client count is instances × 8.
**Verify.** Audit A's page timings at pool 3 vs 8; `poolStats().waiting` is already exported by `@ava/db/client`
and could be logged on slow renders.

### 3. Scans read in full for the catalogue
**Now.** `lastCompletedScanAt` joins `scans → career_sources → company_subscriptions` and takes `max(finished_at)`.
The planner hash-joins and **seq-scans every scan in the catalogue** (EXPLAIN on 7,560 rows: 3.05 ms), so the
cost follows catalogue size × the 90-day retention (`apps/worker/src/maintenance.ts:62`), not this account. It runs
in the layout banner on every full render and every `/api/scan-status` poll. `listCompanies` does a `DISTINCT ON`
over all scans of the page's companies (Sort of 7,560 rows: 6.45 ms); `listCatalogue` repeats it.
**Change.** Per-source LATERAL on the existing indexes:
```sql
select max(x.finished_at)
from company_subscriptions cs
join career_sources src on src.company_id = cs.company_id
cross join lateral (select s.finished_at from scans s
  where s.source_id = src.id and s.finished_at is not null and s.status <> 'failed'
  order by s.started_at desc limit 1) x
where cs.user_id = $1 and cs.status = 'active'
```
**Measured** 0.28 ms, same result. For the list, `companies c cross join lateral (select s.status, s.started_at from
scans s join career_sources cs on cs.id = s.source_id where cs.company_id = c.id order by s.started_at desc limit 1)`
for the page's ids: 0.31 ms. The only semantic difference is "finish time of the newest started scan" versus "latest
finish time", which differ only when two scans of one source overlap.
**Verify.** EXPLAIN on a production-sized clone; the existing scan-strip and companies tests.

### 4. Layout fan-out
**Now.** Every full render pays: session lookup (1, memoised), `getScanStatus` (6 parallel: latest run, system
settings, last completed scan, following count, role counts, suggestion count), `countHealthItems` (2: the SQL count
and `accountAiBudget`). The banner and the count are in Suspense, so they do not hold the shell, which is right,
but they take 8 of the 3 pool slots at the same instant as the page's own reads. On `/`, `Setup` adds 4 more
(`setupStatus`) even for an account whose setup is complete. Soft navigation skips the layout (partial rendering),
but hard loads, `router.refresh()` (#1, AutoRefresh every 10 s while work runs) and action responses do not.
**Change.** One statement for the banner's per-account facts (`following`, `newCompanyMatches`, `lastScanAt` from #3,
and the latest scan run as scalar subqueries), leaving `fetchRoleCounts` separate because it is memoised and shared
with `Setup` and `RoleWorkspace`. One statement for `setupStatus` (its four reads are scalar). Fold the Health count
and the budget into one round trip if `budgetsForMonth` can be expressed as a CTE of the same statement. Keep each
function's signature, so the page and the strip still share one reading.
**Gain.** 12 → 3 pool checkouts on `/` (inferred ≈ 3–4 waves at pool 3).
**Verify.** The capture harness counts statements per function; the scan-status and setup tests.

### 5. Roles page count and landing
**Now.** `fetchRolePage` counts `select count(*) from (baseRolesSelect(...))`: the subquery keeps the inner joins to
`companies` and `career_sources`, which PostgreSQL cannot remove, and the planner runs them as nested loops over
seq scans (1,000 loops each). EXPLAIN: 7.5 ms (analysed clone), 9.0 ms (bench). The latest-application join is
already removed.
**Change.** A dedicated count over `user_jobs ⋈ jobs ⟕ decisions` with the same `conditions` (join `companies`
only when `filters.company` or a company sort needs it; `rolesQuery`'s conditions only reference `companies.id`).
**Measured** 2.1 ms. Also for `/` with no `view`: start `fetchRolePage` for `auto-matched` beside
`fetchRoleCounts` and re-read `user-shortlisted` only when the count of matched is 0 (`defaultRoleTab`), as
`fetchRolePage` already does for a page past the end. Saves one RT on the most-visited URL.
**Verify.** The role-page tests that assert "Showing N of M"; `role_page` log `durationMs`.

### 6. Company page structure
**Now.** `getCompany` (1 RT) → 14 reads in one `Promise.all` (≈ 18 statements with `companySetupRows` and
`companyScanTiming`, each 2 deep; at pool 3 about 6 waves) → only then does JSX reach `RoleWorkspace`, which runs
counts → page, count, pipeline company → stage counts → events (3–4 RT). `getLatestDiscoveryRun(id)` runs twice
(page and `companySetupRows:386`), each `select *` including the `log` JSONB the page never reads;
`companyDiscoveryState` and `companySetupRows`' task read are the same filter.
**Change.** Return immediately after `getCompany`/`notFound()` with two sibling async components, `<CompanyOverview>`
(the 14 reads) and `<RoleWorkspace>`, each in its own `<Suspense>` with a skeleton, so the two chains run side by
side and the header streams first. Wrap `getLatestDiscoveryRun` in `cache()` and select explicit columns (no `log`).
Derive `discoveryState` from `companySetupRows().discoveryTask`.
**Verify.** Page tests; statement count per render drops by 2; time to first byte of the table.

### 7. Applications chain
**Now.** `pipelineCompany` (when `?company=`) → `listPipeline`: `pipelineStageCounts` → page keys (both evaluate
`pipelineIndex`, 4.9 and 5.5 ms measured) → `roleRows` ∥ `legacyRows` → `withBuildProgress` → then
`pipelineCvQuotes`: `getSettingsFor` ∥ `cvBuildQuote` (`getSettingsFor` → Library `content` → the role's
`description_text` → four reads) ∥ description sizes. The capture shows `settings` and `user_settings` each read
twice (#75–78) and the full description of the first row read only for its length.
**Change.** (a) One statement: `with idx as (<pipelineIndex>) select … from idx where stage in (…) order by … limit
50` plus the per-stage counts as a JSON aggregate over `idx`. (b) Start `pipelineCvQuotes` from the page keys'
role ids, beside hydration, instead of after it. (c) In `cvBuildQuote`, run settings, Library and role reads in
parallel, accept precomputed settings, and read `octet_length(description_text)` instead of the text
(`Buffer.byteLength` of a UTF-8 string equals it on a UTF-8 database). ≈ 9 → 5 RT.
**Verify.** `applications` page and `cv-quote` tests; statement count 25 → about 21.

### 8. CV page chain
**Now.** Draft → `dailyCvVersions` (a `to_regclass` probe, then the select: 2 RT, the probe unmemoised) → 5 reads →
medians (only while live) → the application lookup at `:164`. 6–7 RT.
**Change.** Memoise the `cv_versions` probe per process the way `cvBuildColumnsPresent` does (remember only
`true`). After the ownership check, run versions, progress, settings, Library version, sharing and the application
lookup in one `Promise.all`. 3 RT. The progress feed and `CvBuildLive` are untouched.
**Verify.** CV page tests; the page renders the same token (`cvProgressReading`) as before.

### 9. Small sequential awaits
Companies: read `listCompanies` beside `companyCount` and re-read only when the page is past the end (the
`fetchRolePage` pattern). Library: `getCvWritingPreferences` and `listLibraryImports` do not need the Library; start
them with `getOwnCvLibrary`. Suggestions: every second-wave read except `listResolvedSuggestions` can join the
first. Admin catalogue: `pendingNameSuggestionsFor` can join `listCatalogue`'s inner `Promise.all`. One RT each.

### 10. Safe caching of shared data
Safe across accounts (catalogue or deployment-wide): `getSystemSettings()` (schedule, models; written by
`app/actions/settings.ts` and by the worker at boot, `apps/worker/src/settings.ts:68`), `getLatestScanRun()`,
`pipelineCompany(id)`. Use `unstable_cache` with a tag (`system-settings`) and a short revalidate (60 s for
settings, 15 s for the scan run), and `revalidateTag` in the admin settings actions. Saves 2 statements per full
render. Not for caching: anything keyed by an account or reading `user_jobs`, `decisions`, `user_settings`,
`company_subscriptions`, suggestions, CVs, applications, budgets, Health counts, work status, or the session row
(`getCurrentUser` must stay a per-request database read). `listCompanyOptions` looks like catalogue data but reads
subscriptions: per account.

### 11. Planning time (later)
Captured statements for the roles and pipeline queries spend 1.0–2.5 ms in planning, per request, because PgBouncer
in transaction mode rules out named prepared statements. If Render's PgBouncer is ≥ 1.21, `max_prepared_statements`
plus named statements for the three or four heavy queries would remove that. Label: later, needs a platform check.

### 12. pdfkit in page bundles
The server bundles of six pages include `import("pdfkit")` as an async module, pulled in by
`app/actions/cv.ts` and `app/actions/applications.ts`, which import `@/lib/cv-pdf` at module scope. Whether it is
evaluated on a render (and so on every cold start) was not confirmed: a `Module._load` hook while requiring the page
bundle saw nothing, which is inconclusive for an ESM dynamic import. Profile a cold start
(`node --cpu-prof` on `next start`, first request to `/settings`). If it loads, move to
`const { renderCvPdf } = await import("@/lib/cv-pdf")` inside the two actions that render.

## Per-page inventory

| Page | Statements per full render (incl. layout 8 + session 1) | Sequential RT to main content | Streams? |
|---|---|---|---|
| `/` Roles | ≈ 22 | session → counts (no `view`) → page ∥ count ∥ options ∥ stage counts → events = 4 | Banner, Health count, WorkNotice, Setup, Suggestions stream; `RoleWorkspace` gates the body |
| `/companies` | ≈ 20 | session → count → followed → 5 reads = 4 | No |
| `/companies/[id]` | ≈ 33 | session → company → 14 reads (≈ 6 waves) → RoleWorkspace 3–4 | No (see #6) |
| `/applications` | ≈ 25 | session → (company) → counts → keys → hydrate → progress → quotes 3–4 = ≈ 9 | No; quotes could stream |
| `/cv/[id]` | ≈ 17 | session → draft → probe → versions → 5 reads → medians → application = 6–7 | No |
| `/library` | ≈ 14 | session → Library → 4 reads = 3 | No |
| `/settings` | ≈ 15 | session → 4 reads = 2 | No |
| `/suggestions` | ≈ 16 | session → 3 reads → 6 reads = 3 | No |
| `/learning` | ≈ 16 | session → 6 reads = 2 | No |
| `/health` | ≈ 17 | session → 6 reads (Health items 2 deep) = 3 | No |
| `/admin` | ≈ 12 | session → 2 → accounts → budgets = 4 | No |
| `/admin/health` | ≈ 28 | 4 hand-batched waves | No |

Duplicates within one request: `getLatestDiscoveryRun` twice on a company page; `getSettingsFor` twice in
`pipelineCvQuotes`. Everything else that repeats is memoised (`getCurrentUser`, `getSystemSettings`, `getSettings`,
`fetchRoleCounts`, `countHealthItems`, `accountAiBudget`, `getCompanyWorkStatus`, `getCvWorkStatus`).

## What I'd do first
1. **#1, the double render.** It is the cheapest change with the largest effect. It halves server work on the core
   daily action (triage, J/K plus a key), is purely client-side and is verifiable from an existing log line.
2. **#2, the pool on 6432.** One line, measured 23 ms off `/` at r = 5 ms, and it relieves every page and every
   refresh at once. Check Render's PgBouncer client limit first.
3. **#3 + #4, the layout's fixed cost.** The layout runs on every hard load, refresh and action response. The
   LATERAL rewrite is measured at 10–20× and stops a query that grows with the whole catalogue running on every
   page. Collapsing the banner and setup reads removes most of the pool pressure that #2 treats.

Then #5–#8 page by page. Each is small and local.

## Looked at and already good
- Auth: middleware checks only the HMAC (no DB); `getCurrentUser` is `cache()`d and one indexed join; the
  `lastSeenAt` write is at most hourly and off the critical path. (It is a bare `void` promise; `after()` would
  guarantee it completes on serverless. That affects correctness, not speed.)
- The layout already streams the banner and Health count in Suspense; `/` streams WorkNotice, Setup and Suggestions.
- `fetchRoleCounts`, `accountAiBudget`, `countHealthItems` are memoised by account (and month) and shared between the
  layout and pages. They are not shared across accounts, which is correct.
- `RoleWorkspace` reads count and page side by side; the archived section is read only under Dismissed; summary rows
  leave `description_text` in the database; `fetchRecentEventsFor` is a bounded LATERAL on partial indexes
  (1.9 ms for 50 rows).
- Indexes cover every hot per-account path checked: `user_jobs(user_id, …)`, `decisions_active_job_uidx`,
  `job_events` partial indexes, `tasks` JSON-expression indexes for company, draft and user, `scans(source_id,
  started_at)`, `discovery_runs(company_id, started_at desc)`.
- `listLibraryImports` selects summary columns only (never `source_bytes`); `getCompanyScans` and
  `listRecentProblemScans` drop `raw_snapshot`.
- `dynamic = "force-dynamic"` is harmless here: every page reads the session cookie and is dynamic anyway.
- `keepAlive: true`, a 10 s connect timeout, pool error absorption, and no startup parameters on the pooled URL
  (timeouts set on the role per DEPLOY.md) are all correct for PgBouncer.
- `/api/performance` verifies the cookie signature without the database.
