# D. Live updates and writes: performance audit (apps/web)

Scope: polling, `router.refresh()`, API routes, server actions, revalidation, middleware.
Build: the production `.next` for HEAD, served with `next start -p 3152`.

## How I measured

- Database: `ava_perf_d`, a copy of `ava_perf` with 10 extra companies × 50 jobs followed by `demo@ava.local`, giving 509 `user_jobs` rows. Fixture SQL: `scratchpad/perf/D/fixture.sql`. I dropped the database afterwards.
- Query counts: `ALTER DATABASE ava_perf_d SET log_statement='all'`, then I counted the `statement`/`execute` lines for that database in `/var/log/postgresql/postgresql-16-main.log` over each request window. BEGIN and COMMIT are excluded. The counts are exact for this process. They are not affected by `pg_stat` flush lag, which made my first attempt useless.
- Wire: Playwright (Chromium) signed in through `/login` as demo@ava.local. It recorded every request, including Server Action POSTs and `_rsc` GETs, with response sizes. I used Node `fetch` with a forged `v2.` cookie for single endpoints.
- Scripts: `scratchpad/perf/D/{measure2,decide,deck,run,prog}.mjs`.
- Limits: everything is local, so latencies are loopback plus local PostgreSQL. Production adds browser↔Vercel RTT and Vercel↔Render RTT on each of the serial query waves. The pool allows 3 connections per instance (`apps/web/lib/db.ts:12`).

## Ranked findings

| # | Finding | Where | M/I | Estimated gain | Risk | Effort |
|---|---|---|---|---|---|---|
| 1 | Every write that revalidates is rendered twice: the Server Action response already carries the whole re-rendered page tree, and the client then calls `router.refresh()`, which renders it all again | `components/RolesTable.tsx:176,268,288`; `SuggestionDeck.tsx:94`; `FollowCompanyButton.tsx:20`; `SuggestionsStrip.tsx:45,60`; `RefreshCompanyButton.tsx:15`; `LibraryImportForm.tsx:68`. Next: `action-handler.js:773`, `server-action-reducer.js:182-220`, `revalidate.js:156` | **M** | Per role decision: 52 → about 30 queries, 160 KB → 80 KB, one round trip fewer | Low | S |
| 2 | Role decisions are not optimistic. The row leaves only after the action returns, and that includes a full render of the page with its layout | `RolesTable.tsx:247-275` (`setRemovedIds` after `await decide`) | **M** (local) / I (prod) | Perceived latency: about 100–220 ms locally, est. 250–600 ms in prod → about 0 | Low–med | S–M |
| 3 | Swipe deck: the next card is locked until action **and** refresh finish (`pending` spans both) | `SuggestionDeck.tsx:62-99, 202-203` | **M** | 35 queries and about 48 KB per swipe. Next card usable after 130–170 ms locally (est. 0.4–0.8 s in prod) → at once | Low–med | S |
| 4 | During a daily run the Roles and Companies pages refresh the whole tree whenever any task of a followed company changes, including queued→running, which shows nothing on Roles | `lib/work-status.ts:12-24` (md5 over `id‖status`), `app/(app)/page.tsx:20-23`, `AutoRefresh.tsx` | **M** | Measured 2.8 RSC refreshes per tab per minute, 56 of the 74 queries/min. An id-only token for Roles removes about half; a table fingerprint removes most | Low (id-only) / Med (fingerprint) | S / M |
| 5 | `LibraryImportPoller` calls `router.refresh()` on every tick (5 s → 20 s, for up to 10 min) instead of polling a small token | `components/LibraryImportPoller.tsx:23-40` | M (page cost) / I (count) | About 32 full `/library` renders (about 14 queries each, plus the layout) per waiting tab → 1 render plus about 32 two-query polls | Low | S |
| 6 | Fixed layout cost on every refresh and every revalidating action: banner (7 queries) plus Health count (3 or more), in 2–3 serial waves on a 3-connection pool | `app/(app)/layout.tsx:32-40,44`, `lib/scan-status.ts:52-68` | **M** | About 10 of the 20 queries per Roles refresh. Folding the 4 per-account counts into one statement saves 3 queries and a pool wave; the shared `scan_runs`/`settings` reads could get a short in-process TTL (catalogue data only) | Low | S–M |
| 7 | Applications page refreshes once per CV build motion (25 queries, 17.6 KB each) | `app/(app)/applications/page.tsx:139`, `lib/work-status.ts:47-90` | M (per refresh) / I (motions per build) | 10–30 full renders per build per open tab | Med | M (later) |
| 8 | `NavigationMetrics` sends a beacon POST on every navigation (Edge middleware plus a Node function; no DB) | `components/NavigationMetrics.tsx:19`, `app/api/performance/route.ts` | I | One function invocation per navigation; sampling at 10–20 % cuts 80–90 % | Very low | XS |
| 9 | HMAC key is re-imported on every verification (middleware, `getCurrentUser`, `/api/performance`) | `lib/session.ts:68-72` | I | Microseconds per request; tidy-up only | Very low | XS |
| — | CV progress feed: already cheap; no change recommended | `app/api/cv/[id]/progress/route.ts:42-53` | **M** | 2 queries per poll, 725 B steady, 4 KB first read | — | — |

## Measured numbers (local, `ava_perf_d`)

Per endpoint (3 warm repetitions; median latency):

| Request | Queries | Bytes | Median ms | Cache-Control |
|---|---|---|---|---|
| `GET /api/work-status?scope=company` | 2 | 61 | 22 | `no-store` |
| `GET /api/work-status?scope=cv` | 2 | 76 | 17 | `no-store` |
| `GET /api/work-status` (both halves) | 3 | 94 | 22 | `no-store` |
| `GET /api/scan-status` | 7 | 149 | 17 | `no-store` |
| `GET /api/cv/:id/progress` first read (`after=0`, 12 steps) | 2 | 4,018 | 15 | `private, no-store` |
| `GET /api/cv/:id/progress` steady poll (`after=12`) | 2 | 725 | 12 | `private, no-store` |
| `GET /` HTML (Roles) | 20 | 229,331 | 99–240 | `private, no-cache, no-store…` |
| `GET /` RSC refresh (the shape `router.refresh()` sends) | 20 | 78,342 | 58 | same |
| `GET /applications` RSC refresh | 25 | 17,606 | 50 | same |
| `GET /companies` HTML | 18 | 155,627 | 105 | same |
| `GET /library` HTML | 14 | 44,641 | 49 | same |

**Role decision** (Matched tab, keyboard `a` then Enter; 3 rounds, all the same):
- Expanding the row (`roleDetails` action): 1 POST, 5.5 KB, 4 queries. This is fine and happens only on demand.
- Submitting the decision: **2 requests.** First `POST /?view=auto-matched` (Server Action) returning **80,158 B**, then about 50–120 ms later `GET /?view=auto-matched&_rsc` returning **80,142 B**. **52 queries** in total. The row disappeared 98–218 ms after Enter.
- The two responses are the same size because both are a full render of the page from the root. An action request carries no `RSC` header, so `flightRouterState` is undefined (`next/dist/server/app-render/app-render.js:103-105`). Any `revalidatePath` sets `pathWasRevalidated` (`revalidate.js:156`), so `skipFlight=false` (`action-handler.js:773`). The client applies that root render to its cache (`server-action-reducer.js:182-220`).

**Swipe deck** (Dismiss, 3 rounds): POST action about 22–23 KB, then GET `_rsc` about 25 KB. **35–37 queries.** The Dismiss button was enabled again after 129–166 ms.

**Idle tab** on `/` with no work in flight, outside the hour before the scan: **0 requests in 70 s.** AutoRefresh is not mounted and the banner sleeps until `wakeInMs`.

**Simulated daily run** (`run.mjs`): 13 `scan_company` tasks for the account's followed companies, an unfinished `scan_runs` row, and one task moved queued→running→done every 12 s. Recorded over 150 s on `/`:
- 12 × `work-status?scope=company` (720 B in total)
- **7 × `/` RSC refresh (161 KB)**
- 3 × `scan-status`
- 184 app queries

Per tab per minute that is **4.8 status polls, 2.8 full refreshes and 1.2 banner polls, about 8.8 requests and 74 queries.** The refreshes account for about 56 of the 74 queries.

**Times 100 tabs:**
- Idle: about 0 requests/min.
- In the hour before the scan: about 100 banner requests/min, 700 queries/min. The banner caps at 60 s.
- During a run: **about 880 requests/min, 7,400 queries/min, and 2.3 MB/min of RSC** on the Shortlisted default view (23 KB per refresh). A tab left on the Matched view costs 80 KB per refresh, so 22 MB/min.

`scripts/benchmark-users.mjs:23` (`POLL_CADENCE` 10 s / 30 s, 8 requests/min/tab) overstates idle traffic, which is really 0. During a run it is close to the measured count, but it models every request as a cheap status read. It leaves out the refreshes, and those are 3/4 of the database work.

## Findings in detail

### 1. Double render after every revalidating action (MEASURED)
- **Now:** `decide` calls `revalidateDecided()` (`app/actions/decisions.ts:105-110,130`). Next then puts a full root render of the current page into the action response, including the layout's session, banner and Health queries. After the action resolves, `RolesTable` also calls `router.refresh()` (`RolesTable.tsx:268`), which renders it all again.
- The comment at `decisions.ts:99-104` says the layout is spared. It isn't: in this Next version the action response re-renders the layout whatever scope `revalidatePath` is given.
- **Cost:** the measured 52 queries and 160 KB per decision, of which the refresh is about 20 queries and 80 KB. Sites with the same pattern:
  - RolesTable `runGroup` (`RolesTable.tsx:176`) and undo (`:288`)
  - `SuggestionDeck.tsx:94`
  - `FollowCompanyButton.tsx:20`
  - `SuggestionsStrip.tsx:45,60`
  - `RefreshCompanyButton.tsx:15`
  - `LibraryImportForm.tsx:68`
- **Change:** delete `router.refresh()` at those call sites, but only where the called action runs `revalidatePath` on every success path. That holds for `decide`, `decideRoles`, `archiveRoles`, `acceptSuggestion`, `rejectSuggestion` (`suggestions.ts:53,72`), `followCompany` (`companies.ts:185-187`), `acceptFilterSuggestionWithReport` (`learning.ts:167,178-180`) and `rejectFilterSuggestion` (`learning.ts:215`). Check `refreshCompany` and the import actions branch by branch.
- Keep the refresh in `ApplicationsTable.tsx:236`: its comment (`:220-225`) describes a dropped refresh they defend against, and the gain there is small.
- **Constraints:** no test asserts either `revalidatePath` scopes or `router.refresh` calls (`app/actions/decisions.integration.test.ts:24` only mocks `revalidatePath`). `actions.integration.test.ts`, `decisions.integration.test.ts` and `companies.integration.test.ts` cover the action semantics, and those do not change.
- **New tests:**
  1. In `decisions.integration.test.ts` and `companies.integration.test.ts`, assert `expect(revalidatePath).toHaveBeenCalled()` on each success path whose caller no longer refreshes. That locks in the invariant the change relies on.
  2. Re-run `decide.mjs`: expect 1 request (the POST) and about 30 queries per decision.

### 2. Optimistic removal of a decided row (MEASURED locally; production latency INFERRED)
- **Now:** `submitDecision` removes the row only after `await decide(...)` resolves (`RolesTable.tsx:255-265`). That resolution includes the transaction plus the full root render from finding 1. The decision itself is small: `ok()`, no redirect.
- **Change:**
  - Add the row to `removedIds` before the await and show the notice as it is shown today.
  - On `!result.ok` or a throw, take the row out of `removedIds` again and show the error. It is already rendered in the reason box or as `flashError`.
  - Check the skip-needs-reason rule on the client first (`DecideSchema`, `decisions.ts:91-97`, only a non-empty trim) so the common refusal never flashes.
  - Keep `actionsInFlight` so a row cannot be decided twice.
  - Apply the same to undo (`:280-292`) and to group decisions (`:163-181`), where the selection set is already known.
- **Correctness:** the server still decides. The row returns if it refuses. The table re-renders from the action's own tree once it lands (finding 1), so there is no drift.
- **Constraints:** RolesTable has no component test today, and the integration suites are unaffected.
- **New test:** `components/RolesTable.test.tsx` in the style of `CvBuildLive.test.tsx`:
  1. Mock `decide` with a deferred promise.
  2. Press `a` then Enter, and assert the row is gone before the promise resolves.
  3. Resolve with `{ok:false,error}` and assert the row is back with the error.

### 3. Swipe deck waits for two renders (MEASURED)
- **Now:** the card flies off at once (`setDx`), but `gone` is updated only after the action returns (`SuggestionDeck.tsx:88-92`). `busy.current` and the buttons' `disabled={pending}` (`:202-203`) keep the next card locked for the action (a full `/suggestions` render) plus the nested `router.refresh()` transition.
- **Change:**
  - Mark the card `gone` optimistically and track in-flight ids in a `Set` instead of the single `busy` flag.
  - Stop disabling the buttons on the transition's `pending`; disable only while *this* card is in flight.
  - Drop `router.refresh()` (finding 1).
  - On failure, remove the id from `gone`, put the card back on top, and show the error. `acceptSuggestion` can legitimately refuse, for example over follow capacity or the gate not being chosen, and this path covers that.
- **New test:** a deck component test. Swipe twice quickly with deferred action mocks and assert both actions were called and the third card is on top. Then reject the first and assert its card returns with the error.

### 4. Daily run: refresh only when the Roles page could change (MEASURED)
- **Now:** `companyWorkQuery` hashes `tasks.id ‖ tasks.status` (`lib/work-status.ts:12`). Every queued→running transition therefore changes the token, and `AutoRefresh` performs a full refresh for each change it sees (`lib/polling.ts:106-111`).
- The Roles page mounts `AutoRefresh` silently (`app/(app)/page.tsx:20-23`), and `RoleWorkspace` renders nothing derived from task state. I grepped for it; this part is inferred. On Roles, half the refreshes cannot change anything.
- The Companies pages *do* show "Discovering…" versus "Discovery queued" (`companies/page.tsx:139`), so their token must keep `status`.
- **Change, step A (low risk):** add `scope=roles`, rendered by `WorkNotice` and polled by its `AutoRefresh`. Same `active`, but a token over task ids only. A company's scan then triggers one refresh, when its task leaves the set, not two.
- **Change, step B (medium risk, bigger win):** make the Roles token a fingerprint of what the page shows, such as `count` and `max(updated_at)` over the account's `user_jobs` joined to `jobs` (closure and posting edits live on `jobs`), plus the pending filter-suggestion count. Then a scan that found nothing new costs no refresh at all.
- **Constraints:** `lib/polling.test.ts` must stay green unchanged; nothing in `lib/polling.ts` changes. `lib/work-status.test.ts` asserts the company query's plan and cross-account isolation, so extend it for the new scope. `app/api/work-status/route.test.ts:31-43` checks scope dispatch, so add a case for `roles`. `scripts/benchmark-users.mjs` `needsRender` stays valid.
- **New test:** in `work-status.test.ts`, (a) a queued→running transition does not change the `roles` token but does change `company`, and (b) another account's task does not move it.
- **Verify:** re-run `run.mjs /` and expect RSC refreshes to fall from 7 to about 3–4 per 150 s with step A.

### 5. Library import poller refreshes blind (MEASURED page cost, INFERRED count)
- **Now:** while an import is being read, `LibraryImportPoller` calls `router.refresh()` on every tick (`components/LibraryImportPoller.tsx:23-40`), at 5 s growing to a 20 s cap for 10 minutes. That is about 32 full `/library` renders, each 14 queries plus the layout.
- **Change:** poll a two-query token (`GET /api/cv/library/imports?pending=` returning the count and max `updated_at` of the account's pending imports, `private, no-store`, gated by `routeUser()`). Refresh only when it moves, exactly as `LibraryEvidencePoller` already does against `/api/cv/library/reviews`.
- **Constraints:** `app/actions/library-import.integration.test.ts` and `lib/cv-library-page.integration.test.ts` are unaffected.
- **New tests:** a route test in the style of `app/api/cv/library/route.test.ts`, covering 401, another account's import being invisible, and the token moving when an import is answered.

### 6. The layout tax on every refresh and every revalidating action (MEASURED)
- **Now:** each refresh or action render re-runs the layout:
  - `getCurrentUser` (1 query)
  - `getScanStatus` (6 queries in one `Promise.all`, `lib/scan-status.ts:52-60`)
  - `countHealthItems` (2 or more)
- With `max: 3` connections that is at least 3 serial database waves before the banner resolves. It sits in a Suspense boundary, so it streams, but it still holds connections.
- **Change:**
  - Fold `lastCompletedScanAt`, `followingCount`, the Matched count and `suggestionCount` into one statement, all scoped by `userId`. The Matched count must stay the same `roleStatusSql` expression that `fetchRoleCounts` uses; `lib/queries/scan-summary.test.ts` and `lib/scan-status.test.ts` guard "the strip and the page never disagree".
  - `getLatestScanRun` and `getSystemSettings` are shared catalogue data. A 5–10 s in-process TTL is permitted there, but the banner's `scanning` flag would then lag by that much, so it is optional.
- **Verify:** `/api/scan-status` goes from 7 to 4 queries, or to 2 with the TTL.

### 7. Applications table refreshes once per build motion (MEASURED per refresh, INFERRED count)
- **Now:** the `scope=cv` token includes the newest motion name (`lib/work-status.ts:69-72`), so an open Applications tab re-renders the whole page (25 queries, 17.6 KB) for each motion of each build.
- **Later:** return the per-draft label in the `scope=cv` payload and let the building cell render it client-side. Keep `router.refresh()` for status changes only.
- It touches the settle contract, so do it only after 1–4, and keep `lib/polling.test.ts` and `lib/work-status.test.ts` green.

### 8. Navigation beacons (INFERRED)
- **Now:** `NavigationMetrics` calls `sendBeacon('/api/performance')` for every pathname change, including the first load (`components/NavigationMetrics.tsx:15-20`). Each beacon is an Edge middleware run plus a Node function run, with the HMAC checked twice and no database.
- **Change:** sample (for example `Math.random() < 0.2`) or batch on `visibilitychange`.
- **Constraints:** `app/api/performance/route.test.ts` is unaffected.

### 9. HMAC key import per call (INFERRED)
- **Now:** `hmac()` runs `crypto.subtle.importKey` on every verification (`lib/session.ts:68-72`).
- **Change:** memoise the `CryptoKey` per secret string at module scope. `lib/session.test.ts` (if present) and the cookie shape stay the same. The gain is negligible; do it only with other work in that file.

### CV progress stream: confirmed cost, no change recommended (MEASURED)
- **Cadence:** first poll after 10 s, back to 10 s whenever rows arrive, backing off to a 30 s cap (`PROGRESS_LONGEST_MS`, `lib/polling.ts:125`). It stops on finish or when the tab is hidden.
- **Cost per poll:** `routeUser` (1 query) plus one `readCvProgress` statement (`lib/queries/cv.ts:236-275`), so 2 queries. 725 B in steady state (the running step is always resent, plus build state), 4 KB for the first read.
- **ETag/304:** not a real win. The server would still run both queries to compute the body, `live`/`build` depend on `now`, and it would save under 1 KB per poll. Leave it alone.
- **Tests any change must keep:** `app/api/cv/[id]/progress/route.test.ts`, `components/CvBuildLive.test.tsx`, `lib/polling.test.ts`.

## Middleware (INFERRED from code; no issue found)
- **Matcher** (`middleware.ts:22-27`) excludes `_next/*`, the favicon and icons, the manifest, `brand/*`, the auth pages, `api/health`, `api/cron` and `api/newsletters`. It **does** run on every page, RSC request, Server Action POST, API poll and `/api/companies/:id/logo`.
- **Per request:** one HMAC-SHA256 over a short string (`lib/session.ts:99-111`, about µs).
- **Headers:** `NextResponse.next()` adds none. The only header it sets is `private, no-store` on `/share/*`, which is intended. It adds nothing that breaks caching.
- **Cost:** on Vercel it is an extra Edge invocation per poll. Excluding API polls would shift the 401 to `routeUser()`, which already handles it, but that is a policy change for a small saving. Not recommended.

## API routes: caching verdicts
- **work-status / scan-status / progress / library reviews:** per-account and polled at 10 s or slower from a single tab, with the client using `cache: "no-store"`. A `private, max-age=5` would not remove any request, and a 304 saves bytes (61–149 B) but no queries. The saving is in the refreshes, not here.
- **`/api/companies/:id/logo`:** already good. It is versioned `?v=`, `public, max-age=86400, immutable`, with ETag/304 (`route.ts:40-49`). Browsers ask once.
- **`/api/cv/library`** (`GET`): read only on an obsolete-save conflict (`CvLibraryEditor.tsx:190`), not on mount. Fine.
- **Server `fetch()` to the app's own routes:** none (`lib/email.ts` and `lib/google.ts` call external APIs only).
- **Client fetch on mount duplicating server data:** none. `AutoRefresh` with `initialVersion`, `ScanStatusBanner`, `CvBuildLive` and `LibraryEvidencePoller` all wait before their first read (`AutoRefresh.tsx:83-84`, `ScanStatusBanner.tsx:97`, `CvBuildLive.tsx:184`).

## Server actions: revalidation map (frequent ones)

| Action | Revalidates | Returns | Redirect | Caller refreshes too |
|---|---|---|---|---|
| `decide` / `decideRoles` / `archiveRoles` | `/`, `/applications`, `/companies`, `/companies/[id]` page (`decisions.ts:105-110`) | `ok()` | no | yes (double render) |
| `acceptSuggestion` | `/suggestions`, `/companies`, `/` (`suggestions.ts:53`) | message | no | yes |
| `rejectSuggestion` | `/suggestions` | message | no | yes |
| `followCompany` | `/companies`, `/suggestions`, `/` | message | no | yes |
| `unfollowCompany` | `/`, `/companies` | — | **yes, `/companies`** (`companies.ts:517`), an extra round trip; acceptable because it is rare | n/a |
| `addCompanies` | `/companies`, `/suggestions`, `/` | — | yes, with a status query string (form post) | n/a |
| `saveGate` and other settings actions | `/settings`, `/companies`, `/` (`settings.ts:48-50`) | ActionResult | no | no (useActionState) |
| `saveCvLibrary` | `/library`, `/cv` (`cv.ts:140-141`) | ActionResult | no | no |
| `setRoleStage`, `manageRoleCv`, `updateProfile` | include `revalidatePath("/", "layout")` (`applications.ts:234,389`, `account.ts:75`) | row / result | no | ApplicationsTable yes (kept deliberately) |

The `"layout"` scope makes no difference to the action's own response, which is a root render either way. What it adds is invalidation of cached data for every path. All pages are `force-dynamic` and there is no `unstable_cache` in `apps/web`, so there is nothing server-side to invalidate. Leave the scopes as they are.

## What I would do first
1. **Finding 1: drop `router.refresh()` after revalidating actions.** It is the one change that halves the server cost of every write (measured 52 → about 30 queries and 160 → 80 KB per decision), it removes a round trip, and it is a few deleted lines guarded by one new assertion per action.
2. **Findings 2 and 3: optimistic role decisions and deck swipes.** The server still decides and a failure puts the row or card back. This removes all the waiting from the two hottest interactions. It needs two new component tests.
3. **Finding 4A: a `roles` work token over task ids only.** A few lines in `lib/work-status.ts` and `app/(app)/page.tsx` with no change to `lib/polling.ts`, cutting daily-run refreshes on Roles by about half. Step B is the follow-up that removes most of the rest.

## Already good
- Idle tabs cost nothing. `ScanStatusBanner` sleeps until the hour before the scan, with jittered wake-ups and a `visibilitychange` recheck (`ScanStatusBanner.tsx:49-53,88-96`). `AutoRefresh` mounts only while work is active.
- Every poller parks on hidden tabs, aborts after 8 s, backs off while nothing changes, and stops when work finishes (`lib/polling.ts`).
- A layout refresh with a new banner signature re-arms the banner timer, so the banner rarely polls during a run (measured: 3 in 150 s instead of 5).
- `getCurrentUser` is one joined query, memoised per request, and writes `lastSeenAt` at most hourly (`lib/auth.ts:22-39`).
- The API routes return small JSON, `no-store`, with correct 401 handling (`lib/route-auth.ts`). The logo route caching is correct.
- `roleDetails` loads the heavy description only when a row expands (5.5 KB, 4 queries).
