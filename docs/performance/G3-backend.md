# G3. Backend and API efficiency

Code checked at `069cdef` (PR #81 merged). **V** means verified in the code or measured here. **I** means inferred.
New measurements were taken on `ava_perf_bench` (1,000 `user_jobs` per account). The 10,000-role figures come from 9,000 extra `jobs` and `user_jobs` rows for load user 1, added and `ANALYZE`d inside a transaction that was then rolled back.
Scripts and SQL are in `scratchpad/perf/g3/`: `run.sql`, `run10k.sql`, `narrow1k.sql`, `hyd10k.sql`, `pdftime.mts`, `pdfload.mts`.
Timings are local database time, `jit=off`, warm, on a shared 4-vCPU host (±20 %).

Already done in #81, not repeated below:
- one render per write (`router.refresh()` removed after actions that revalidate);
- optimistic decisions;
- per-request `cache()` dedupe;
- the combined shell statement;
- the landing page reads Matched beside the counts;
- company page split into two streamed halves;
- CV page reads in one wave;
- slim `countRoles` (no `companies`/`career_sources` join);
- per-source LATERAL for the newest scan;
- pool of 6 on the pooled URL;
- `roles` work token over task ids.

---

## B1. Role page: sort and limit on narrow keys, then hydrate 50 rows ("deferred join")

- [ ] **Recommendation.** Split `fetchRoleRows` into two steps.
  - Step 1: order and limit over `user_jobs ⋈ jobs ⟕ decisions`, selecting only `job_id`.
  - Step 2: join the wide columns (`companies`, `career_sources`, latest application, the `cv_drafts` EXISTS, about 60 columns) for those 50 ids only.
- **Mechanism.** Keep one statement:
  ```sql
  … where jobs.id in (select job_id from (
        select uj.job_id from user_jobs uj join jobs … left join decisions …
        where <conditions> order by <sort keys> limit 50 offset $n) k)
    and <conditions> order by <sort keys> limit 50
  ```
  - The page is `baseRolesSelect` with the key subquery added to the `where`.
  - Leave the `json_build_array` cursor on the outer select so CSV export (`app/api/export.csv/route.ts:57`) keeps working.
  - Root cause, from EXPLAIN at 10k:
    - The CASE-expression filters make the planner estimate 1–150 rows where there are 9,944.
    - It therefore picks nested loops over `companies` and `career_sources` (94k rows removed by join filter).
    - It carries 820-byte rows into the sort. The narrow query needs neither join.
- **Status.** Not done. `lib/queries/jobs.ts:670-673` (`baseRolesSelect(userId, true, cursor)…orderBy…limit…offset`). **V**
- **Impact (measured).** Page-1 query:
  - 1,000 roles: 13–17 ms → 4–5 ms.
  - 10,000 roles: 131–205 ms → 41–44 ms.
  - The page query is the slowest statement on `/` (A-after: 12.5 ms) and sits on the critical path of `/` and `/companies/[id]`.
- **Effort.** M.
- **Risk.** The order or filters could drift between the inner and outer query.
  - Guard: build both from the same `rolesQuery()` `{conditions, order}`.
  - Guard: the existing role-page tests assert "Showing N of M" and the order.
  - Guard: add a test that page 2 of the deferred form equals page 2 of the current form on the fixture.

## B2. Pagination: keep offset and page numbers; reuse the tab count

- [ ] **Recommendation.**
  - Keep `LIMIT 50 OFFSET (page-1)*50` for the UI. Do not move the table to keyset.
  - Skip the separate `countRoles` when the only filter is the view. `fetchRoleCounts` (memoised, already read on `/`) holds the same number: `counts[view]`.
- **Mechanism.**
  - Every sort key is computed: the status bucket depends on `now`, and `fit_score` is nullable, with `nulls last`. No index can deliver the order, so every page sorts the account's whole filtered set, whatever the pagination style.
  - Keyset would only replace the top-N heap with a filtered sort. It would lose "page 7 of 20", and it breaks when `now` moves a row between buckets.
  - Keyset already exists where it fits: streamed CSV export (`fetchRoleRows({after})`, `jobs.ts:645`).
  - With B1, a deep offset costs the narrow sort only.
  - A deep offset spills to disk at 10k (`external merge 4096kB`); `work_mem` belongs to INFRA.
- **Status.**
  - Offset: in place. `jobs.ts:753-762`: count and page run in parallel; the page is re-read only past the end. **V**
  - Count slimmed: done.
  - Count reuse: not done. **V**
- **Impact (measured).**
  - Page query at offset 0 / 450 / 900 on 1k roles: 14–17 / 17–18 / 18–19 ms.
  - At 10k, offset 0 / 450 / 4,950 / 9,900: 131–205 / 150–155 / 229–241 / 219–221 ms.
  - `countRoles`: 2.7 ms at 1k, 28 ms at 10k. Reusing the tab count removes it, and one pool slot, on default views.
- **Effort.** S.
- **Risk.** The tab count and the filtered count could diverge if a filter is added later. Guard: reuse only when `filtersToQueryString(filters)` is empty, and add a test that the two agree on the fixture.

## B3. Events: take them off the table payload and out of the render chain

- [ ] **Recommendation.** Stop calling `fetchRecentEventsFor` in `RoleWorkspace`. Return the archive events from the `roleDetails` action, which already loads on row expand.
- **Mechanism.**
  - The table renders events in one place only, inside the expanded panel: `row.events.filter(e => e.label.includes("archiv"))` (`components/RolesTable.tsx:713`).
  - The page nonetheless reads up to 12 events per row, `payload` JSONB included, in a sequential wave after the page (`RoleWorkspace.tsx:62`), and ships them all.
  - In `roleDetails`, select only `type`, `at`, `payload->>'action'` and `payload->>'reason'`.
- **Status.** Not done. **V**
- **Impact.**
  - One sequential round trip fewer on `/` and `/companies/[id]` (1.9 ms database time per B, plus one Vercel→PgBouncer RT).
  - `events` is 12.5 KB of the 63 KB rows prop, **250 B/row, 20 %** (measured from `a/home.rsc`, 50 rows).
- **Effort.** S.
- **Risk.** The archive note would appear only after expansion data loads. That is where it already sits, so there is no visible change. Guard: a RolesTable test for the archived note after expand.

## B4. Role row view model: drop constants and per-row company duplication

- [ ] **Recommendation.** Three cuts to `buildRoleRowVM` (`lib/queries/jobs.ts:521-574`):
  1. `liveForTitle`: replace one of two fixed sentences, plus the seeded suffix, with `liveForBasis: "posted" | "first_seen"`. The client holds the strings.
  2. Company fields: `companyHomepageUrl`, `companyDomain`, `companyFaviconUrl` and `companyLogoUrl` repeat per row. Send one `companies: Record<id, {…}>` map prop to `RolesTable`.
  3. `fitRationale` is used only in a `title` and the expanded panel (`RolesTable.tsx:62,687`). Move it to `roleDetails` if a real account's rationales prove long. The fixture has none.
- **Mechanism.** These are plain props on a client component. RSC serialises every key of every row: key names alone are **519 B/row** (39 keys), and nothing dedupes repeated strings across rows.
- **Status.** Not done. **V**
- **Impact.**
  - Measured per-field bytes, 50 rows, 1,259 B/row:
    - `liveForTitle`: 101 B/row (8 %);
    - the four company fields: 122 B/row (10 %);
    - ISO `*Title` fields: 43–79 B/row.
  - With B3, the estimate is ≈ 1,259 → ≈ 850 B/row: −20 KB on a 50-row page. The inline HTML copy shrinks by the same amount.
- **Effort.** S–M. `RoleRowVM` is shared with tests (`RolesTable.test.tsx`).
- **Risk.** A missing company entry would render a blank favicon. Guard: build the map from the same rows, and type the lookup as non-optional.

## B5. `/companies`: one client Manage menu instead of per-row server forms

- [ ] **Recommendation.** Replace `CompanyControls` (a server component with three or four `<form action={x.bind(null, companyId)}>` per row) with a client `CompanyManageMenu`.
  - It takes `{companyId, companyName, status, running, blockedReason}`.
  - It calls the imported actions with `companyId`, and renders its buttons and confirm texts only when opened.
- **Mechanism.** A bound action serialises per row:
  - a reference `{"id":…,"bound":"$@n"}` (66 B);
  - a bound-args chunk (43 B);
  - the `Button` design-system class strings (≈ 250 B each).

  An unbound action reference is serialised once per page.
- **Status.** Not done. `app/(app)/companies/CompanyControls.tsx:28-53`, `companies/page.tsx:164`. **V**
- **Impact (measured on `a/comp.rsc`).**
  - A row is 3,691 B plus 3 × 109 B of bound references.
  - The `<details>` block is **1,496 B (≈ 40 %)**.
  - Estimate: −30 KB of the 99 KB RSC for 20 rows, and the same again in the HTML's inline flight data.
- **Effort.** S.
- **Risk.** A client-supplied `companyId`. Guard: `setCompanyStatus` already scopes by `requireUser()` plus `company_subscriptions.user_id` (`app/actions/companies.ts:195-204`), and so do the archive and unfollow actions. Keep `zUuid().parse`.

## B6. Remaining sequential awaits per page

- [ ] **Recommendation, by page.**
  - **`/companies`:** read `listCompanies(page)` beside `companyCount`, and re-read only past the end (the `fetchRolePage` pattern). `companies/page.tsx:46-48`.
  - **`/suggestions`:** move every second-wave read except `listResolvedSuggestions` (which needs `page`) into the first `Promise.all`. `suggestions/page.tsx:119-124`.
  - **`/admin/catalogue`:** three waves become one plus one. Run `listCatalogue` beside `catalogueCount`, with the same re-read rule, and `pendingNameSuggestionsFor` in the same statement or beside it. `admin/catalogue/page.tsx:24-27`.
  - **`/applications`:** CV quotes still wait for hydration (`applications/page.tsx:66`).
    - Stream them: a `<Suspense>` child fed by `pipelineCvQuotes(user.id, keys)` and started from the page keys.
    - Fold `pipelineStageCounts` and the page keys into one `with idx as (…)` statement (B #7a).
    - Deliberately left in #81.
  - **Layout Health count:** still 2 statements, SQL count plus `accountAiBudget` (`lib/queries/health.ts:1223-1246`). Fold them if the budget sum can be a CTE. Deliberately left.
  - **`/library`:** `importProgress` waits for the first wave (`library/page.tsx:38`). It is conditional on pending imports, so leave it.
- **Mechanism.** `Promise.all` over independent reads. Suspense streaming for below-the-fold parts.
- **Status.** Partial. #81 removed the large chains (A-after: `/cv/[id]` 9.3 → 4.9 RT, `/applications` 12.8 → 8.1, `/companies/[id]` 14.8 → 10.9). **V** for the lines cited.
- **Impact.** One round trip each (**I**). `/applications` ≈ 3–4 RT (B #7).
- **Effort.** S each; M for Applications.
- **Risk.** Low. The re-read-past-the-end pattern already exists and is tested in `fetchRolePage`.

## B7. Triage action response: a full page render per decision

- [ ] **Recommendation.** Decide whether the hottest action (`decide`) should keep `revalidatePath`.
  - Option A (keep): the response carries the whole page, so tab counts, banner and pipeline stay exact. Make that render cheaper with B1 and B3.
  - Option B (lean): `decide` returns `{ok, counts}` with no revalidation. The client applies the optimistic removal, which already exists, plus the returned tab counts. Cached routes are invalidated on the next navigation (`staleTimes.dynamic` defaults to 0 in Next 15).
- **Mechanism.**
  - Any `revalidatePath` inside an action sets `pathWasRevalidated`, and the response then carries a root render (D, `action-handler.js:773`). The scope argument does not change the response.
  - `revalidateDecided()` revalidates `/`, `/applications`, `/companies` and `/companies/[id]` (`app/actions/decisions.ts:106-111`).
- **Status.** Option A is in place. **V**
- **Impact (A-after, measured).** 92,856 B and 26–27 statements per decision. Option B estimate: ≈ 0.5 KB and ≈ 4 statements (transaction plus a count).
- **Effort.** M.
- **Risk (Option B).**
  - Stale layout counts (banner, Health) until the next navigation.
  - Back/forward shows cached trees.
  - Guard: return the counts from the same `roleCountsFor` query.
  - Guard: keep revalidation on undo and bulk actions.
  - Guard: a component test that the tab counts move.
  - Recommend A until B1 and B3 land, then re-measure.

## B8. Roles work token: fingerprint what the table shows

- [ ] **Recommendation.** Replace the `roles` token (`companyWorkQuery(userId, "ids")`, `lib/work-status.ts:43-46`) with a fingerprint over the account's table: `count(*)`, `max(uj.updated_at)`, `max(j.updated_at)` and the pending filter-suggestion count.
- **Mechanism.** One indexed aggregate on `user_jobs(user_id)` joined to `jobs`. A scan that finds nothing new then triggers no refresh. Client polling cadence belongs to FRONTEND.
- **Status.** Partial: the ids-only token is done (step A); the fingerprint is not (deliberately left). **V**
- **Impact.**
  - D measured 2.8 full refreshes per tab per minute during a run: 56 of 74 queries/min, 80 KB per refresh on Matched.
  - Estimate: most of those refreshes disappear.
- **Effort.** M.
- **Risk.** A missed change if some visible column moves without `updated_at`. Guard: a `work-status.test.ts` case per writer (scan update, closure, score, decision), plus the cross-account isolation test.

## B9. `pg` pool settings (app side)

- [ ] **Recommendation.**
  - Web on the pooled URL: `idleTimeoutMillis: 120_000`, so a warm, quiet instance does not redo TLS and PgBouncer auth.
  - Wrap the pool with `attachDatabasePool(pool)` from `@vercel/functions`, so idle clients close before a Fluid instance suspends.
  - Keep `keepAlive: true`, `connectionTimeoutMillis: 10_000`, and no startup parameters on 6432.
- **Mechanism.** `pg.Pool` options in `packages/db/src/client.ts:180-191`.
  - `serverTimeouts()` sends `statement_timeout` / `idle_in_transaction_session_timeout` only off PgBouncer. On 6432 they must come from `ALTER ROLE … SET statement_timeout='30s'` (`docs/DEPLOY.md:104-116`).
- **Status.**
  - Web `max` 6 pooled / 3 direct, override `WEB_DB_POOL_MAX` (`apps/web/lib/db.ts:6-38`): **done**.
  - `idleTimeoutMillis` is 30 s for every pool: **not done**.
  - `@vercel/functions` is not a dependency: **not done**.
  - Worker `max = (WORKER_CONCURRENCY + CV_CONCURRENCY) × 2 + 4` = 26 at defaults (`apps/worker/src/env.ts:60`), direct URL, 5-minute statement timeout: appropriate.
  - Role timeout on production: **not verifiable from the repo**.
  - **V** (code).
- **Impact.** Estimate: one TLS plus PgBouncer auth handshake (≈ 2–3 RT) saved on the first query after 30–120 s idle. Fewer half-dead sockets after a Fluid suspend.
- **Effort.** S.
- **Risk.** More idle client slots held on PgBouncer (instances × 6). Guard: DEPLOY.md's client-limit arithmetic; `poolStats()` in the slow-render log.

## B10. Prepared statements: worker now, web only after a PgBouncer check

- [ ] **Recommendation.**
  - **Worker** (direct 5432): make the queue claim a named prepared statement.
    - Rewrite the lane and exclusion filters as array parameters (`type = any($1::text[])`, `type <> all($2::text[])`) so it is one statement text.
    - Then use Drizzle `.prepare("claim_task")` or `pg` `{name, text, values}`.
    - Do the same for `renewTask` and the lease renewal.
  - **Web**: do nothing until Render's PgBouncer version is known.
- **Mechanism.**
  - `pg` sends a named Parse once per connection and binds thereafter.
  - Through PgBouncer transaction pooling, named statements are lost across backends unless PgBouncer is ≥ 1.21 with `max_prepared_statements > 0`. That tracks protocol-level Parse, which is what `pg` uses. The limits themselves are INFRA.
- **Status.** Not done anywhere. There is no `.prepare(` and no named `QueryConfig` in `apps/`, `packages/db`, or `packages/core` (grep). **V**
- **Impact (measured).**
  - Claim query: planning 2.7 ms vs execution 0.6 ms (18 queued tasks).
  - Role page statement: planning 1.9–5 ms per execution (this run); B measured 1.0–2.5 ms.
  - The idle worker runs about 280 claims/min (B11), so ≈ 12 s of planner CPU per minute is avoidable (estimate).
- **Effort.** S (worker). L (web: needs a platform check).
- **Risk.**
  - A generic plan chosen after 5 executions could be worse for skewed lanes. Guard: `plan_cache_mode` stays `auto`; compare the EXPLAIN of the 6th execution.
  - Named statements on the web without PgBouncer ≥ 1.21 fail with `prepared statement "x" does not exist`. Guard: never enable on 6432 without that check.

## B11. Task queue: stop polling an empty queue every 3 s per slot

- [ ] **Recommendation.**
  - Add `LISTEN ava_tasks` on one dedicated `pg.Client` in the worker (direct URL, outside the pool).
  - Wake idle slots on a notification.
  - Raise the idle poll to 15–30 s as the fallback.
  - The cheaper first step: exponential idle backoff, 3 → 15 s, reset whenever a claim succeeds.
- **Mechanism.**
  - The web and `enqueueTask` / `enqueueTasks` (`packages/db/src/tasks.ts:87-122`) issue `select pg_notify('ava_tasks', '')` in the same transaction as the insert, or a statement-level `after insert on tasks` trigger does it.
  - NOTIFY is delivered on commit and works through transaction pooling. Only LISTEN needs a session, and the worker already has a direct connection.
  - Claims already use `for update skip locked` on the lane index (`apps/worker/src/queue.ts:185-203`). Batch claims are not needed, since one slot runs one task.
- **Status.** Not done. **V**
  - `pollMs ?? 3000` (`queue.ts:729`).
  - 3 general plus 8 CV slots. Each general slot tries its lane, then `all` (`queue.ts:782-783`).
  - No `pg_notify` anywhere.
- **Impact.**
  - Idle load: ≈ 14 claims per 3 s ≈ 280/min ≈ 400k statements/day (**I**, from the code; planning-dominated, see B10).
  - Pickup latency for work someone waits for (refresh company, CV build start, tag reason): average 1.5 s, worst 3 s → ≈ 0 with NOTIFY (**I**).
- **Effort.** S (backoff). M (NOTIFY).
- **Risk.** Notifications are lost while the listener reconnects. Guards:
  - keep the fallback poll;
  - reconnect with backoff;
  - on reconnect, poll once immediately;
  - payload-free notifications, so nothing depends on their content.

## B12. Worker N+1: the remaining per-row writes

- [ ] **Recommendation.** Use the existing `enqueueTasks()` batch insert and multi-row `insert … returning` in:
  - `handlers/companies.ts:154-166`: an insert plus `enqueueTask` per candidate, inside a transaction;
  - `companies.ts:266-272`: per-company `profile_company` enqueue;
  - `external-sources.ts:116,165`;
  - `daily.ts:88-90`: per-logo `discover` enqueue.

  Lower value:
  - `learning.ts:33` `ensureSeedTags` per user at boot;
  - `handleReevaluateGate` over all accounts, sequential, with a lease per account (`learning.ts:457`), which is correct;
  - `daily.ts:112` `finalise` per open run.
- **Mechanism.** `insert into tasks … values (…),(…) on conflict do nothing`, with dedupe keys unchanged (`insertTasks`).
- **Status.** Partial. The scan hot path is batched and was checked:
  - new jobs in chunks of 100;
  - views and events in chunks of 250;
  - seen-row updates in chunks of 5,000;
  - field and description updates through `jsonb_to_recordset`;
  - narrow description reads, chunked by 1,000 (`handlers/scan.ts:678-973`).

  Adopted user postings are still 2 statements each (`scan.ts:645-675`). They are rare. Change detection in `packages/core` is pure and does no I/O. **V**
- **Impact.** Estimate: tens of statements per discovery or suggestion run. Not user-visible.
- **Effort.** S.
- **Risk.** A batch insert changes the returned ids. Guard: `enqueueTasks` already applies the dedupe rule within a batch; keep the queue tests.

## B13. Model-API calls: what remains

- [ ] **Current state, verified in `packages/ai/src`.**
  - Every call streams.
  - Idle cut-off: `AI_STREAM_IDLE_MS`, default 5 min. Ceiling: 15 min (`engine.ts:379-391`).
  - Cache breakpoints are declared per prompt in the registry and validated: at most 4, longer TTL first (`prompt-registry.ts:165-173`).
  - Writer: library and role at 1 h. Audit: evidence at 1 h, CV at 5 min. A5 and A12: system and account block at 5 min.
  - Usage records carry cache read, 5-minute write and 1-hour write tokens (`engine.ts:406-443`).
  - Audit batches of 8. The first runs alone until its stream begins, then the rest run together.
  - The claim memo re-asks only changed claims (`claim-memo.ts`).
  - The governor shares throttle pauses.

  **Nothing to change in caching or streaming.**
- [ ] **Recommendation.** Send high-volume background call sites through the Message Batches API: A5 `score_job` first, then A4 and A9.
- **Mechanism.**
  - `client.messages.batches.create({requests:[{custom_id, params}]})`, at 50 % of standard token prices, including cached tokens.
  - Most batches finish within an hour; the maximum is 24 h.
  - Results arrive in any order: key them by `custom_id` (`taskId:userId:jobId`).
  - A worker task collects `score_job` rows every N minutes, submits them, and a poll task applies the results.
  - Caching works inside batches on a best-effort basis.
  - The A5 cached prefix on the default scoring model must reach 1,024 tokens. The system prompt is about 600 tokens, so a new account with an empty profile does not cache. That is harmless, because nothing is written either.
- **Status.** Not done. No `batches` use. **V**
- **Impact.** −50 % on A5, A4 and A9 spend (estimate: A5 runs once per admitted role per account). Scores appear minutes to an hour later, not seconds.
- **Effort.** M–L. Budget holds must settle when the results land.
- **Risk.**
  - Expired or errored results. Guard: requeue as ordinary `score_job` tasks.
  - Holds stay open across the wait. Guard: reserve per batch, release on result or expiry.
  - Keep interactive routes (A6, A11, A12, CV) synchronous.

## B14. CV PDF: render once per revision, and load pdfkit lazily

- [ ] **Recommendation.**
  1. Keep the bytes that `finaliseCvDraft` already renders and discards (`app/actions/cv.ts:797`), keyed by draft id and content hash.
     - Serve downloads from them.
     - Have "record application" copy them instead of rendering again (`app/actions/applications.ts:279`).
     - Render on request only for previews.
  2. Move `import { renderCvPdf } from "@/lib/cv-pdf"` from module scope in `app/actions/cv.ts:5` and `app/actions/applications.ts:10` to `await import()` inside the two actions (B #12).
- **Mechanism.**
  - Storage: a `bytea` column or a `cv_pdfs(draft_id, content_hash, bytes)` table.
  - A finalised revision is immutable (spec: "existing revisions are immutable"), so the key never goes stale.
  - The ETag/304 header policy belongs to GLOBAL.
- **Status.** Not done. The download route re-renders on every request (`app/api/cv/[id]/pdf/route.ts:38-41`). **V**
- **Impact (measured, `g3/pdftime.mts`, short CV).**
  - Render: 117 ms first, 11–34 ms warm, +26 MB RSS during renders.
  - Module load: 808 ms and +57 MB under `tsx`. That includes TS transpilation, so it is an upper bound.
  - The comments say long CVs take "seconds". Moving rendering to the worker is not justified at these sizes.
  - Whether the page bundles evaluate pdfkit on a cold start is **unverified** (B #12). Profile it before claiming a gain.
- **Effort.** S (lazy import). M (stored bytes).
- **Risk.** Stored bytes going out of step with content. Guard: store the content hash beside them, and re-render when the hash differs.

## B15. JSONB and wide rows read where one field is used

- [ ] **Recommendation.** Explicit column lists instead of `select()`:
  - **PDF download route:** `getOwnCvDraft` reads the whole draft (`library_snapshot`, `job_description`, `assessment`, `build_checkpoint`, `gap_quiz`, `content`) to use `content`, `status`, `finalisedAt`, `companyName` and the finalisable fields (`lib/queries/cv.ts:184`, `api/cv/[id]/pdf/route.ts:16`).
  - **Finalise pre-read** (`actions/cv.ts:790-793`) and **record-application pre-read** (`actions/applications.ts:277`): the same shape. The locked re-read inside the transaction can stay full.
  - **Worker sweeps:** `requeueStale`, `failSpentTasks` and `recoverFromCrash` (`queue.ts:402,444,492`) and the admin task lists (`lib/queries/health.ts:830,868`) read `tasks.payload` and `result` in full.
  - **Refresh action:** `refreshCompany`'s pending-task check (`actions/companies.ts:244`) needs only `id` and `status`.
  - **Events:** `job_events.payload` on the role page (B3).
- **Mechanism.** `db().select({ … })` with the used columns. JSONB is detoasted only when selected.
- **Status.** Not done for the paths listed. The CV page itself uses most columns, so it is fine. `getCompanyScans` already drops `raw_snapshot` and `listLibraryImports` drops `source_bytes` (B). **V**
- **Impact.** The fixture `library_snapshot` averages 4.3 KB. Real Libraries are larger (estimate 10–60 KB) per PDF request and per finalise or record. The admin task lists avoid `result` blobs.
- **Effort.** S.
- **Risk.** A field later needed but not selected. Guard: TypeScript types it from the select shape, so a missing field fails `pnpm -r typecheck`.

---

Cross-references (other sections own these):
- `work_mem` for the 10k external-merge sort, PgBouncer limits and versions, and indexes: INFRA.
- Cache-Control and ETag on PDFs and polls: GLOBAL.
- Poll cadence and hydration: FRONTEND.
- Per-call-site cache-hit monitoring from `ai_usage`, and `pg_stat_statements` planning time: TESTING & MONITORING.
