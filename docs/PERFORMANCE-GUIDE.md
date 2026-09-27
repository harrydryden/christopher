# AVA performance tuning guide

Scope: the Next.js 15.5 interface on Vercel (fra1), the Node worker on Render (Frankfurt) and Render Postgres 16 behind PgBouncer, as of 27 September 2026; statuses reflect `main` at commit `069cdef` (PR #81 merged) and the production database as checked today.

Legend.
- **Status:** done / partial / not done / not applicable.
- **Evidence:** [V] verified in code or config (or in the production settings read on 2026-09-27); [M] measured by the source audit (A-baseline, A-after, B, C, D, or the G1–G5 research passes on the `ava_perf_bench` and `ava_perf_infra` fixtures; all ten reports are in [docs/performance/](performance/)); [I] inferred, with the check that would verify it.
- **Effort:** S (hours), M (a day or two), L (more).

### 1. Global & Cross-Cutting Architecture

Response classes today, the basis for this section's cache policy:

| Class | `Cache-Control` today | Source |
|---|---|---|
| Authenticated HTML and RSC, `(app)/**` | `private, no-cache, no-store, max-age=0, must-revalidate`; `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch` | [V] `force-dynamic` in every page and `(app)/layout.tsx:17`; `next/dist/server/lib/cache-control.js:15`, `base-server.js:1145` |
| Auth pages (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/verify`) | same as above | [V] `app/login/page.tsx:9` and siblings |
| `/share/[token]` | `private, no-store` from middleware | [V] `middleware.ts:31-35` |
| `/api/*` JSON and polls, 401s | `no-store` or `private, no-store` | [V] `lib/route-auth.ts:20`, `middleware.ts:44` |
| CV and application PDFs | `private, no-store` | [V] `api/cv/[id]/pdf/route.ts:54`, `api/applications/[id]/pdf/route.ts:17` |
| Company logo | versioned `?v=`: `public, max-age=86400, immutable`; else `public, max-age=3600`; `ETag` from capture time | [V] `api/companies/[id]/logo/route.ts:41-47` |
| `_next/static/*`, `icon.svg`, `apple-icon.png` | `public, max-age=31536000, immutable` | [M] A-baseline §1; [V] build output |
| `favicon.ico`, manifest, `public/brand/*` | `public, max-age=0, must-revalidate` (default) | [V] favicon; [I] the others |

**1.1 Keep per-account HTML and RSC uncacheable, and make a test fail if that ever changes.**
- Mechanism: RFC 9111 `private` plus `no-store` on every authenticated page and every `RSC: 1` response. Vercel's CDN stores a function response only when it carries `s-maxage`, `CDN-Cache-Control` or `Vercel-CDN-Cache-Control` [I]. Next's `Vary` omits `Cookie`, which is safe only while pages stay `private, no-store`. Do not add `ETag`/304 to HTML, RSC or polls: a conditional GET still pays the full render to compute the hash, pages stream, and poll bodies are 61–149 B [M D].
- Policy (load-bearing, CLAUDE.md): per-account data (`user_jobs`, decisions, settings, profiles, CVs, applications) is never cached across accounts, never held in a CDN or Service Worker, and never served from a replica (section 4, Evaluated and not recommended). Only shared catalogue bytes such as logos may be public.
- Status: done [V] (commit a4f59e6): `scripts/smoke-web.mjs` asserts `private, no-store`, no `public`/`s-maxage`/CDN header and no `set-cookie` on every signed-in page, the `/cv` redirect and `RSC: 1` refetches of `/` and a company page (API answers: `no-store`); allow-list logo, `_next/static`, metadata icons.
- Change: in `smoke-web.mjs`, for every authenticated page and one `RSC: 1` refetch, assert `cache-control` contains `private` and `no-store`, contains neither `public` nor `s-maxage`, and that no `set-cookie` is returned. Allow-list: the logo route, `_next/static`, metadata icons.
- Impact: none on latency; it prevents one account's table being served to another.
- Effort: S. Risk → guard: none.

**1.2 Cache versioned company logos on Vercel's CDN, and answer 304 before reading the blob.**
- Mechanism: on the versioned 200 path (`?v=` equals the capture time) add `CDN-Cache-Control: public, max-age=31536000, immutable` beside the existing browser `Cache-Control`; `max-age` alone is browser-only on Vercel [I]. The query string is in the cache key, so a re-capture changes the URL. Select `fetched_at` first and compare `if-none-match` before reading the `bytea`.
- Status: done [V] (commit d6b4e3e): `CDN-Cache-Control: public, max-age=31536000, immutable` on the versioned 200 only; a request with `if-none-match` reads `fetched_at` alone (`companyLogoVersion`) and answers 304 without the blob; no validator still reads in one statement. Option A: middleware unchanged. Route tests for the 200/304/404 header sets; smoke stores a logo and checks 200 then 304.
- Impact: estimate. A cold browser on `/` requests up to 50 lazy logos, about 15–20 above the fold. A hit removes the invocation and both round trips for every account after the first fetch per edge region, and stops logo requests competing for the 6-connection pool (3.3).
- Option B (needs a policy decision): drop `routeUser()` and exclude `api/companies/*/logo` from the middleware matcher, so a hit costs zero invocations.
- Effort: S. Risk → guard: a revoked session with a validly signed cookie can fetch a cached logo, which the route already allows ("any cache may hold it", `:43`); purge via Vercel or bump `fetchedAt` for a takedown. Emit the CDN header only on the versioned 200, never on 404 or 304; add a case beside `logo/route.test.ts`.

**1.3 Measure the real fra1 to Render round trip once, then budget sequential waves by it.**
- Mechanism: time `select 1` on a warm pooled connection and log it at each instance's cold start. Every Vercel to Render hop is the public External URL over TLS (`docs/DEPLOY.md:191`); there is no private network between the providers. The Edge middleware does HMAC only, no database (`middleware.ts`, `lib/session.ts`).
- Status: done [V] (commit 4b223ff): the interface pool logs `database_round_trip` (`ms` = min of 3 warm `select 1`, `samplesMs`, `endpoint`, `region`) once per instance after its first query. After: 0.4–0.5 ms locally; the fra1 figure is read from Vercel's logs after deploy.
- Re-check [I]: `curl -sI https://<host>/api/health | grep -i x-vercel-id` should contain `fra1`.
- Budget for a warm navigation, UK user (estimates except where marked):

  | Leg | Round trips | ms |
  |---|---|---|
  | Browser to Vercel PoP (warm h2/h3) | 1 | 5–20 |
  | PoP to fra1 function | 1 | 10–20 |
  | Edge middleware (HMAC only) | 0 DB | under 1 |
  | Function to PgBouncer at pool 6 | 4.4 on `/`, 7.6 on `/companies/<id>` [M A-after §2] | × 1–5 per RT (assumed, never measured) = 4–38 |
  | New browser connection (cold) | +1 (QUIC) to +2 (TCP + TLS 1.3) | +10–40 |

- Impact: if the RTT exceeds 5 ms, every sequential wave counts about 5× more than the audits assumed, which reorders section 3's priorities.
- Effort: S. Risk → guard: none.

**1.4 Add a static set of security headers, kept cache-neutral.**
- Mechanism: a `headers()` rule for `/:path*` in `next.config.ts`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on `/share/:path*`, whose URL is the credential), `Content-Security-Policy: frame-ancestors 'none'` and a minimal `Permissions-Policy`. Never add `Vary` with them. Avoid a nonce CSP: it forces a per-request render; use `'self'` plus hashes or `strict-dynamic` without nonces.
- HSTS: `*.vercel.app` is under the preloaded `.app` TLD, so there is no http to https round trip today. On a custom domain outside `.app`, send `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` and submit it, which removes the 301 on typed URLs.
- Status: done [V] (commit bc88af8): nosniff, Referrer-Policy (`no-referrer` on `/share/*`), Permissions-Policy on every response; `frame-ancestors 'none'` and a Report-Only CSP ('self' + the hash of Next's bootstrap script) on every response but the logo, whose sandbox CSP a `headers()` value would otherwise replace. No Vary. Asserted in the smoke test. Enforcing the full CSP still needs a nonce or `'unsafe-inline'` for Next's per-response flight scripts.
- Impact: about 0 on performance (a few hundred bytes on the first response, then header-compressed); the gain is security.
- Effort: S. Risk → guard: a full CSP can break Next's inline bootstrap; ship `Content-Security-Policy-Report-Only` first and assert the headers in the smoke test.

#### Already in place

- **1.5 Compression by Vercel's edge** (done by platform [I]). Brotli, falling back to gzip, on streamed HTML and `text/x-component`; Next's `compress` applies only to `next start`. `/` is 243,479 B of HTML and 22,117 B gzip (11×) [M A-after §1]; Brotli is about 10–15 % smaller [M C]. Never set `content-encoding` in a handler. Check: `curl -sI -H 'Accept-Encoding: br' https://<host>/login | grep -i content-encoding` expects `br`.
- **1.6 One origin over HTTP/2 and HTTP/3** (done [V] for same-origin; protocol [I]). Fonts are self-hosted by `next/font`, no third-party scripts [M C]. The only cross-origin fetches are uncaptured favicon fallbacks in `lib/company-icon.ts`, lazy and off the critical path. Check: DevTools Protocol column or `curl --http3 -I`.
- **1.7 Session as a 105 B signed id with a database row** (done [V]). `ava_session=v2.<uuid>.<epoch>.<HMAC>`, `HttpOnly`, `SameSite=Lax`, `Secure`, 30 days (`lib/auth.ts:101-107`); one indexed join per request memoised with `cache()` (`auth.ts:21`); `lastSeenAt` throttled hourly (`auth.ts:34-36`, made safe in 4.6). Remove the `christopher_session` fallback after 2026-10-23 (`session.ts:17-20`).
- **1.8 Global state in Postgres, not instance memory** (done [V]). Sessions, `tasks`, rate limits (`lib/rate-limit.ts`) and settings live in the database. The one per-instance cache, `lib/scan-run-report.ts:16-18`, is 30 s, 1,000 entries, keyed `runId|userId`.

#### Evaluated and not recommended

- Edge-caching `/share/[token]`: a revocation must take effect and views are recorded (`recordCvShareView`).
- Prerendering the auth pages: one hit per sign-in, and they read env at request time.
- `ETag`/304 on the CV PDF: downloads are rare and rate-limited (`refuseCvRender`); render-once storage (3.13) is the better lever.
- `preconnect` to company or DuckDuckGo hosts: would open up to 50 origins. 103 Early Hints: Vercel does not send them for functions [I; look for `HTTP/2 103` in `curl -v`], and `next/font` already sends `Link: rel=preload` for 5 fonts (36,968 B) with the first byte.
- A cross-request in-memory cache of settings or catalogue data: each instance would serve different data (PERFORMANCE-REVIEW, last paragraph); a managed KV hop costs about what the 1–5 ms DB round trip it saves.

### 2. Frontend & Client-Side Optimization

First-load JS, gzip level 9, rebuilt at `069cdef` (Next 15.5.25, React 19.2.8) [M G2]:

| Route | Now (KB) | A-after (KB) | C baseline (KB) | Route-specific chunks (gz) |
|---|---|---|---|---|
| `/cv/[id]` | 134.7 | 133.4 | 159.7 | page 19.5 + shared 3.6 |
| `/companies/[id]` | 128.2 | 126.2 | 124.0 | roles table 10.7 + 2.6 + page 3.4 |
| `/library` | 126.6 | 125.2 | 150.7 | page 11.4 + shared 3.6 |
| `/` | 126.0 | 124.0 | 121.8 | roles table 10.7 + 2.6 + page 1.2 |
| `/applications` | 120.6 | 119.2 | 117.6 | page 6.5 + 2.6 |
| `/suggestions` | 118.2 | 116.5 | 114.8 | page 6.6 |
| `/settings` | 114.8 | 113.4 | 140.4 | page 3.2 |
| other app pages | 111.7–114.8 | 110.4–113.4 | 109–112 | under 2 |
| auth pages | 106.4 | 106.4 | 103.8 | none |

Shared floor about 108 KB (react-dom 54.3, router runtime 46.2, `next/link` 3.4, `(app)/layout` 4.0). The roles-table chunk grew from 33.9 to 36.0 KB raw since A-after (correctness-sweep commits). CSS is one file, 41,191 B raw / 8,503 B gzip. Budgets that hold these numbers: see 5.1.

**2.1 Stop preloading Silkscreen 700 once its one use is settled, and give IBM Plex Mono a monospace fallback.**
- Mechanism: `Silkscreen({ weight: ["400"], subsets: ["latin"], display: "swap", variable: "--font-pixel-family" })`; `IBM_Plex_Mono({ ..., adjustFontFallback: false, fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"] })`. Plex advances 600/1000 em, Menlo 602, Courier New 600, so line breaks and `tabular-nums` match far better than `local("Arial")` at `size-adjust: 134.59%`.
- Status: done [V] (commit 1a071ca): the evidence table's `<th>` cells carry `ds-pixel` themselves; Silkscreen is loaded at 400 only and Plex Mono falls back to the system monospace stack with `adjustFontFallback: false`. Built CSS: 21 → 18 `@font-face` rules (no Silkscreen 700, no Plex size-adjusted fallback), next-font preloads 5 → 4 files, CSS 41,191/8,530 → 40,442/8,481 B raw/gzip.
- Change: put `ds-pixel` on those `<th>` cells (as `components/table.tsx` `TH` already does) or add `font-normal` to the head, then remove 700 and update the font line in `docs/DESIGN-SYSTEM.md`. That header changes from bold to regular pixel, a visible design decision to take deliberately.
- Impact: −3,208 B and one request on every hard load, `/login` included [M]; font-swap CLS on a cold first visit from ≤ 0.02 to about 0 (estimate). Merging Plex 500 (10,052 B, used 23 times in 14 files) is a separate design-system decision.
- Effort: S. Risk → guard: synthesised bold anywhere `ds-pixel` meets a bold context (`<th>`, `<strong>`, `<kbd>` in `font-semibold` containers); grep for those and check `/library`, `/`, `/suggestions` and the CV tabs.

**2.2 Stop the roles table re-rendering all 50 rows on each keystroke, `j`/`k` press and reason-box edit.**
- Mechanism: extract `const RoleRow = memo(function RoleRow(props) {...})` taking primitives (`highlighted`, `selected`, `busy`, `expanded`, `detail`, `boxed`) and handlers through one ref-backed dispatcher so identities stay stable; a `ReasonBox` child owns `useState(prefill)` and reports `onSubmit(text)`; `export const SafeMarkdown = memo(SafeMarkdownImpl)`.
- Status: done [V] (commit 9457018). `RoleRow` is a memo component on primitives with a ref-backed `RowActions` object, `ReasonBox` owns its text, `SafeMarkdown` is memoised. After, on 50 rows (`RolesTable.renders.test.tsx`, a Profiler per row): a reason-box keystroke renders 0 rows (was 50), `j`/`k` 2 (the rows whose highlight moved; was 50), `x` 1 (was 50); an open description is not re-parsed when its row renders.
- Impact: estimate, no browser profile run. About 50 × 40 fibers per keystroke, 2–5 ms desktop and 10–25 ms on a mid-range Android phone, enough with input delay to reach INP "needs improvement"; after, one row, under 1 ms.
- Effort: M (the row reads about 15 closure variables).
- Risk → guard: a stale callback acting on the wrong row; route handlers through a ref updated every render, keep `RolesTable.test.tsx` green, add a `<Profiler onRender>` test asserting one row renders per keystroke.

**2.3 Store company logos as a 64 px WebP at capture, not the site's original icon.**
- Mechanism: `sharp(bytes).resize(64, 64, { fit: "contain", background: { r:0, g:0, b:0, alpha:0 } }).webp({ quality: 90, effort: 4 })`, stored as `image/webp` (already sniffed, `packages/core/src/logo-capture.ts:59`). Keep SVG as is. For ICO, pass on the largest PNG-embedded entry ≥ 32 px, else keep the original. `sharp.concurrency(1); sharp.cache(false)` on the 512 MB worker. The largest slot is 32 CSS px; 64 px covers 2× DPR. Backfill with a one-off task.
- Status: done [V] (commit 05f1604): `normaliseLogo` (core) re-encodes through an injected `encodeLogo` (worker, sharp 64 px WebP, concurrency 1, no cache), keeps SVG, takes an ICO's largest PNG ≥ 32 px, and keeps the original on any error; one-off `reencode_logos` task in passes of 25 (`pnpm cli reencode-logos`) bumps `fetched_at` and `logo_fetched_at`. No database holds captured logos; synthetic 180 px PNG 55,601 B → 986 B, 256 px 113,065 B → 938 B.
- Impact: estimate. Touch icons 5–30 KB and 256 px ICOs 15–100 KB become 1–3 KB: about 50–400 KB less per cold roles page, less decode. No CLS change (dimensions already set).
- Effort: M. Risk → guard: a resize failure must not lose the logo; on any sharp error store the original and log; resize by sniffed type; keep `fetched_at` as the version so the backfill busts the immutable URL (1.2).

**2.4 Gate the CV build clock on visibility and on the log being open.**
- Mechanism: in `tick`, return when `document.visibilityState !== "visible"` and tick on `visibilitychange`; in log mode compute `narrateBuild(...)` only while open, or memoise on `[steps, Math.floor(now / 15_000)]`.
- Status: done [V] (commit c1a2926): the tick is a no-op while hidden and fires on `visibilitychange`; the log's narrative renders only while open (`CvDisclosure mountWhenOpen`).
- Impact: about 1–3 ms of main thread per second for a build's duration (estimate); battery and INP on the CV page.
- Effort: S. Risk → guard: elapsed figures must jump correctly on return; tick at once on `visibilitychange` (the `skewRef` clock already corrects).

**2.5 Load the CV build narrative only when the log is opened on a finished CV.**
- Mechanism: `next/dynamic` with no `loading` option (the `components/CvLazyWidgets.tsx` pattern, no Suspense flash), triggered from `CvDisclosure`'s `open` state; only the `mode="log"` path with `!reading.live`.
- Status: done [V] (commit 9d1112e): narrative views split into `CvBuildViews` via `next/dynamic` (no `loading`); a finished CV fetches the chunk only when the log opens; a failed chunk shows a sentence. `/cv/[id]` first load 134,423 → 125,125 B gzip; page chunk 19,483 → 10,502 B gzip; the lazy chunk is 10,505 B gzip.
- Impact: 5–8 KB gzip off `/cv/[id]`'s 134.7 KB plus less hydration on ready CVs (estimate).
- Effort: M. Risk → guard: keep `CvBuildLive.test.tsx` green; a failed chunk shows a sentence, as in commit `8a5b781`.

**2.6 Memoise the CV draft editor's baseline fingerprint.**
- Mechanism: `const baseline = useMemo(() => JSON.stringify({ ...content, theme: baseTheme }), [content, baseTheme])`.
- Status: done [V] (commit 1282df9): baseline memoised on `[content, baseTheme]`; one stringify per keystroke instead of two.
- Impact: under 1 ms per keystroke at 5–20 KB (estimate; fixture libraries are 4.3 KB [M]). `useDeferredValue` becomes worthwhile only above about 100 KB.
- Effort: S. Risk → guard: none.

**2.7 Pre-shape the gap quiz's library on the server.**
- Mechanism: pass `{ entries: {id, heading}[], employment: {id, company, jobTitle}[] }` instead of the whole `draft.librarySnapshot` (`app/(app)/cv/[id]/page.tsx:284-286`).
- Status: done [V] (commit 7feb6f9): `gapQuizLibrary`/`gapQuizForm` shape it on the server; the prop is typed from the shaped object. Bench snapshots average 4,307 B of JSON against about 91 B shaped. Impact: a few KB less RSC and HTML while a quiz is open (estimate). Effort: S. Risk → guard: type the prop from the shaped object so typecheck catches a missing field.

**2.8 Park the Library pollers while the tab is hidden.**
- Mechanism: the `AutoRefresh` pattern (flag plus `visibilitychange`) in `components/LibraryImportPoller.tsx:30-70`; today the `until` ceiling keeps counting while hidden, so a returning user gets no refresh.
- Status: done [V] (commit 9e003ee): both pollers park while hidden, give the time away back to the ceiling and poll at once on return. Impact: correctness only; fetches are already skipped while hidden. Effort: S, when touched for another reason.

#### Already in place

- **2.9 zod out of every first load** [M]: `/settings` −29 KB, `/library` −28, `/cv/[id]` −29 KB gzip; chunk `9269` is async only, and no client chunk contains cheerio, parse5, drizzle or `ZodError` [V].
- **2.10 Pollers back off, park and stop** [V]: `AutoRefresh` 10 s ×1.5 to 60 s; `ScanStatusBanner` 30 s to 60 s, sleeping to the next run with 1–60 s jitter (`ScanStatusBanner.tsx:32-106`); `CvBuildLive` 10 s to 30 s. Server cost of polling: see 3.4.
- **2.11 Triage interaction** [V]: optimistic removal with revert (`RolesTable.tsx:140-156`); one request per decision (A-after §5); deck sends 8 cards, not 50 (`suggestions/page.tsx:111,122`).
- **2.12 Lazy CV widgets without Suspense flash** [V]: `CvGapQuiz`, `CvShareCreateForm`, `CvEvaluationTable` (`CvLazyWidgets.tsx`); `CvContentSchema` and the library merge loaded lazily.
- **2.13 CLS** [V]: `CompanyFavicon` sets dimensions, `loading="lazy"`, `decoding="async"` (`CompanyFavicon.tsx:25-37`); layout fallbacks take the replaced content's box (`(app)/layout.tsx:45-47, 69-72`). LCP is server-bound: TTFB plus the page segment render (A-after: `/` p50 64 ms locally).
- **2.14 Animation** [V]: `transform`-only, stepped, reduced-motion aware (`globals.css:172-189, 327-336`; `SuggestionDeck.tsx:63-69, 213`).

#### Evaluated and not recommended

- Service Worker: hashed assets are already immutable for a year, and caching per-account HTML would render for revoked sessions; adds 5–50 ms startup on mobile navigations (estimate).
- React Compiler: skips components that touch `ref.current` in render (`RolesTable`, `SuggestionDeck`, `CvBuildLive`), so the hot paths gain nothing; do 2.2 by hand.
- `experimental.inlineCss`: adds 8.5 KB to every hard-load HTML (22 KB gzip on `/`) and loses the cross-visit cache for daily returning users.
- Sidebar prefetch: keep `prefetch={false}` (`NavLink.tsx:31`, commit `c836da9`: 50 rows prefetched the layout 100 times). Revisit with hover-intent `router.prefetch(href, { kind: PrefetchKind.FULL })` plus `staleTimes: { static: 30 }` only if sidebar navigation p75 from 5.4 exceeds about 400 ms.
- `optimizePackageImports`, `images` config, `next/image` for logos (the optimiser fetches without the cookie and would get a 401 from `route.ts:31`), table virtualisation (50 server-paginated rows; `j`/`k` and find-in-page need real rows), `will-change` (does not promote SVG paths), AVIF at 64 px.

### 3. Backend & API Efficiency

Timings are local database time, `jit=off`, warm, on `ava_perf_bench` (1,000 `user_jobs` per account; 10,000-row figures from a rolled-back load for one user), ±20 % [M G3].

**3.1 Reuse the tab count instead of running `countRoles` on default views.**
- Mechanism: when `filtersToQueryString(filters)` is empty, read `counts[view]` from `fetchRoleCounts` (memoised, already read on `/`) and skip the separate count statement.
- Status: done [V] (commit 37acb9b). A view that is a whole tab (`tabCountedBy`) takes `counts[tab]` from the memoised `fetchRoleCounts`; anything narrower is counted. After: no count statement on default views (it was 1.0 ms at 1,000 and 8.5 ms at 10,000 after 3.5); `RoleWorkspace` on a named view sends 4 statements side by side.
- Impact: `countRoles` is 2.7 ms at 1,000 roles and 28 ms at 10,000 [M], plus one pool slot per default render.
- Effort: S. Risk → guard: filtered and tab counts could diverge if a filter is added; reuse only on the empty filter string and add a fixture test that both agree.

**3.2 Take events off the table payload and out of the render chain.**
- Mechanism: drop `fetchRecentEventsFor` from `RoleWorkspace` (`RoleWorkspace.tsx:62`); return archive events from the `roleDetails` action already loaded on row expand, selecting only `type`, `at`, `payload->>'action'`, `payload->>'reason'`. The table uses events in one place, inside the expanded panel (`components/RolesTable.tsx:713`).
- Status: done [V] (commit 23c0a42). `roleDetails` returns `archiveNotes` from `fetchArchiveNotes` (action and reason only); the page reads no events. After: 50-row Matched rows prop 63,085 → 50,435 B on `ava_perf_bench`, and no sequential events wave.
- Impact: one sequential round trip fewer on `/` and `/companies/[id]` (1.9 ms database time plus one Vercel to PgBouncer RT) and 12.5 KB of the 63 KB rows prop, 250 B/row, 20 % [M A-baseline, 50-row RSC capture].
- Effort: S. Risk → guard: the archive note appears after expansion, where it already sits; add a RolesTable test for the note after expand.

**3.3 Pool settings: keep warm connections for two minutes and release them before Fluid suspends.**
- Mechanism: in `packages/db/src/client.ts:180-191`, web pool on the pooled URL `idleTimeoutMillis: 120_000` (up to 300 s is safe: Render's PgBouncer `client_idle_timeout` is 86,400 s); wrap it with `attachDatabasePool(pool)` from `@vercel/functions`. Keep `keepAlive: true`, `connectionTimeoutMillis: 10_000`, `ssl: require`, and no startup parameters on 6432. A new connection costs TCP (1 RT) + `SSLRequest` (1 RT) + TLS 1.3 (1 RT) + PgBouncer SCRAM (about 2 RT).
- Status: done [V] (commit 6a06798): pooled `idleTimeoutMillis` 120 s, direct 30 s (`webPoolIdleTimeoutMs`), pool registered with `attachDatabasePool`; `keepAlive`, 10 s connect timeout and no timeouts on 6432 unchanged. Worker keeps 30 s.
- Impact: estimate. 4–5 RT × 1–5 ms, 5–25 ms off the first navigation after each pause over 30 s, for up to 6 parallel connections; fewer half-dead sockets after a suspend.
- Effort: S. Risk → guard: more idle client slots on PgBouncer (instances × 6 against `max_client_conn` 30,000, not a constraint, 4.1); `absorbConnectionError` (`client.ts:137`) already drops sockets the pooler closes; `poolStats()` sits in the slow-render log.

**3.4 Roles work token: fingerprint what the table shows, not the task ids.**
- Mechanism: replace `companyWorkQuery(userId, "ids")` (`lib/work-status.ts:43-46`) with one indexed aggregate over `user_jobs(user_id)` joined to `jobs`: `count(*)`, `max(uj.updated_at)`, `max(j.updated_at)` and the pending filter-suggestion count. A scan that finds nothing new then triggers no refresh.
- Status: done [V] (commit dc010cf). One statement: the pending flag plus an md5 over the account's view count, max `user_jobs.updated_at` and `score_state_at`, max `jobs.updated_at`, the closed count, active decisions and pending suggestions. After: a scan that finds nothing new moves nothing; the fingerprint costs 1.1–2.0 ms at 1,000 roles and 10.7–12.4 ms at 10,000 [M, `ava_perf_bench`].
- Impact: D measured 2.8 full refreshes per tab per minute during a run, 56 of 74 queries/min, 80 KB per refresh on Matched [M]; most disappear (estimate).
- Effort: M. Risk → guard: a visible column changing without `updated_at`; one `work-status.test.ts` case per writer (scan update, closure, score, decision) plus the cross-account isolation test.

**3.5 Roles page query: sargable predicates, then sort 50 narrow keys and hydrate only those ("deferred join").**
- Mechanism:
  - (a) State `user_jobs.user_id = $1 and in_table and archived_at is null` as plain predicates outside the view `CASE` (`… end <> 'archived' and decisions.id is null`), and drop the freshness filter (`… end in ('new','active','closed')`) when every state is selected.
  - (b) Keep one statement, `baseRolesSelect` with a key subquery in the `where`:
    ```sql
    … where jobs.id in (select job_id from (
          select uj.job_id from user_jobs uj join jobs … left join decisions …
          where <conditions> order by <sort keys> limit 50 offset $n) k)
      and <conditions> order by <sort keys> limit 50
    ```
  - Keep the `json_build_array` cursor on the outer select so CSV export (`app/api/export.csv/route.ts:57`) still works.
- Why: the `CASE` filters make the planner estimate 1–150 rows where 944 (1k) or 9,944 (10k) come back, so it nested-loops `companies` and `career_sources` (94k rows removed by join filter) and carries 820-byte rows into the sort [M G3, G4]. The predicate form is also what lets `user_jobs_table_idx` serve the auto-matched view without a new index (4.13).
- Status: done [V] (commit f4b3578). After, EXPLAIN ANALYZE execution on `ava_perf_bench`, Matched: page 1 15.2 → 3.1–5.7 ms at 1,000 roles and 132.5 → 16.3 ms at 10,000; offset 4,950 at 10,000 237.9 → 22–23 ms; planning rose from about 2 to about 5 ms. "No decision" is written on `decisions.job_id` (an anti-join the planner estimates), and the plan reads `user_jobs_table_idx` with `(user_id, in_table, archived_at)` as its index condition.
- Impact: page-1 query 13–17 → 4–5 ms at 1,000 roles and 131–205 → 41–44 ms at 10,000 [M]; it is the slowest statement on `/` (A-after 12.5 ms) and on the critical path of `/` and `/companies/[id]`.
- Effort: M. Risk → guard: inner and outer order or filters drifting; build both from one `rolesQuery()` `{conditions, order}`, keep the "Showing N of M" and order tests, add a test that page 2 matches the current form.

**3.6 Task queue: stop polling an empty queue every 3 s per slot.**
- Mechanism:
  - First step: exponential idle backoff 3 → 15 s, reset on a successful claim.
  - Then `LISTEN ava_tasks` on one dedicated `pg.Client` (direct URL, outside the pool); `enqueueTask`/`enqueueTasks` (`packages/db/src/tasks.ts:87-122`) issue `select pg_notify('ava_tasks', '')` in the insert's transaction, or a statement-level `after insert on tasks` trigger does; raise the fallback poll to 15–30 s.
  - NOTIFY is delivered on commit and works through transaction pooling; only LISTEN needs a session.
- Status: done [V] (commit 993bdd2): backoff 3 → 15 s reset on a claim; `pg_notify('ava_tasks', '')` in `enqueueTask`/`enqueueTasks`' transaction; one LISTEN client outside the pool (`apps/worker/src/task-wakeup.ts`), fallback poll up to 30 s while listening, reconnect 1 → 30 s with a poll on reconnect. Idle statements per minute (3 general + 8 CV slots, empty queue) 280 → 28 after a 70-statement first minute [M]; a task enqueued during a 10 s wait starts in under 1 s (test).
- Impact: idle load about 14 claims per 3 s, 280/min, 400,000 statements/day, planning-dominated [I, from code]; pickup latency for refresh, CV start and tag reason from 1.5 s average / 3 s worst to about 0 with NOTIFY [I].
- Effort: S (backoff), M (NOTIFY). Risk → guard: notifications lost while reconnecting; keep the fallback poll, reconnect with backoff, poll once on reconnect, payload-free notifications.

**3.7 Prepared statements: the worker's claim now, the web only after a PgBouncer probe.**
- Mechanism:
  - Worker (direct 5432): rewrite the claim's lane filters as array parameters (`type = any($1::text[])`, `type <> all($2::text[])`) so it is one text, then Drizzle `.prepare("claim_task")` or `pg` `{name, text, values}`; the same for `renewTask`. `pg` sends a named Parse once per connection.
  - Web (PgBouncer 6432), probe first: with a pool of 2, run `pool.query({ name: 'probe', text: 'select 1' })` 20 times in separate transactions. `prepared statement "probe" does not exist` means PgBouncer is older than 1.21 or `max_prepared_statements = 0`. If supported, name the statements whose planning exceeds execution.
- Status: done for the worker [V] (commit e384597): lanes as `text[]` parameters, claim as two named statements (`claim_task_lane`, `claim_task_open`; one text folding both would lose `tasks_lane_idx`), `renew_task` named. ava_perf_infra, planning from the 6th execution: CV lane 0.52 → 0.025 ms, background 0.60 → 0.026 ms; the scan lane keeps custom plans under `plan_cache_mode = auto` (0.55–0.64 ms) [M]. Web: `scripts/pgbouncer-prepared-probe.mjs` (exit 0 supported, 2 not, 1 could not run); no web statement is named until it passes on Render.
- Impact: planning vs execution [M]: claim 0.8–2.7 vs 0.6–1.8 ms; pipeline keys #820 3.0 vs 1.9; stage counts #264 2.1 vs 0.6; roles page 1.9–5 vs 20 ms. About 12 s of planner CPU per idle minute on the worker (estimate; shrinks after 3.6).
- Effort: S (worker), M (web). Risk → guard: a generic plan after 5 executions could suit skewed lanes or large accounts badly; keep `plan_cache_mode = auto`, compare the 6th execution's EXPLAIN and `pg_stat_statements` (5.3), drop `name:` from any regression. Never name statements on 6432 without the probe.

**3.8 `/companies`: one client Manage menu instead of per-row bound server forms.**
- Mechanism: replace `CompanyControls` (3–4 `<form action={x.bind(null, companyId)}>` per row, `app/(app)/companies/CompanyControls.tsx:28-53`, `companies/page.tsx:164`) with a client `CompanyManageMenu({companyId, companyName, status, running, blockedReason})` that calls the imported actions and renders buttons only when open. A bound action serialises a 66 B reference, a 43 B bound-args chunk and about 250 B of `Button` classes per row; an unbound reference is serialised once per page.
- Status: done [V] (commit 0f7bf14): `components/CompanyManageMenu.tsx`, used on `/companies` and `/companies/[id]`. `/companies` with 20 rows: RSC 101,286 → 68,044 B (−33 %), HTML 232,525 → 133,173 B (−43 %) [M].
- Impact: a row is 3,691 B and its `<details>` block 1,496 B (about 40 %) [M A-baseline, RSC capture]; −30 KB of the 99 KB RSC for 20 rows, the same again in inline flight data (estimate).
- Effort: S. Risk → guard: a client-supplied `companyId`; the actions already scope by `requireUser()` and `company_subscriptions.user_id` (`app/actions/companies.ts:195-204`); keep `zUuid().parse`.

**3.9 Explicit column lists where only a few fields of a wide row are used.**
- Mechanism: `db().select({ … })` with the used columns; JSONB is detoasted only when selected. Targets:
  - `getOwnCvDraft` in the PDF route (`lib/queries/cv.ts:184`, `api/cv/[id]/pdf/route.ts:16`) reads `library_snapshot`, `job_description`, `assessment`, `build_checkpoint`, `gap_quiz` to use `content` and a few fields;
  - the finalise and record-application pre-reads (`actions/cv.ts:790-793`, `actions/applications.ts:277`); the locked re-read in the transaction can stay full;
  - worker sweeps `requeueStale`, `failSpentTasks`, `recoverFromCrash` (`queue.ts:402,444,492`) and admin task lists (`lib/queries/health.ts:830,868`), which read `payload` and `result`;
  - `refreshCompany`'s pending check (`actions/companies.ts:244`), which needs `id` and `status`.
- Status: done [V] (commit c1fefb3): `getOwnCvDraftForPdf` (keeps `library_snapshot` and `job_description`, which `assertCvFinalisable` hashes), finalise and record pre-reads, `requeueStale`/`failSpentTasks` (all but `result`), `recoverFromCrash`, the admin running/retrying lists, `refreshCompany`'s pending check.
- Impact: fixture `library_snapshot` averages 4.3 KB [M]; real libraries 10–60 KB per PDF request, finalise or record (estimate).
- Effort: S. Risk → guard: a later-needed field not selected fails `pnpm -r typecheck`.

**3.10 Role row view model: drop constants and per-row company duplication.**
- Mechanism: in `buildRoleRowVM` (`lib/queries/jobs.ts:521-574`) replace `liveForTitle` with `liveForBasis: "posted" | "first_seen"` (the client holds the strings); send one `companies: Record<id, {…}>` prop instead of four company fields per row; move `fitRationale` to `roleDetails` if real rationales prove long (`RolesTable.tsx:62,687`). RSC serialises every key: key names alone are 519 B/row (39 keys).
- Status: done [V] (commit ed14a47). `liveForBasis` replaces `liveForTitle`, one `companies` map prop replaces four fields per row, and the seven label/ISO fields, `sourceType` and `locationOk` the table never read are gone; `fitRationale` stays on the row (the prompt caps it at two sentences; stored ones average 86 characters). After: 50-row rows prop 50,435 → 30,933 B plus a 2,443 B companies map (668 B/row, from 1,262 before 3.2).
- Impact: of 1,259 B/row [M], `liveForTitle` is 101 B (8 %), company fields 122 B (10 %), ISO `*Title` fields 43–79 B; with 3.2, about 1,259 → 850 B/row, −20 KB per 50-row page, the same in the HTML copy (estimate).
- Effort: S–M (`RoleRowVM` is shared with `RolesTable.test.tsx`). Risk → guard: a missing company entry renders a blank favicon; build the map from the same rows and type the lookup non-optional.

**3.11 Remove the remaining sequential awaits per page.**
- Mechanism: `Promise.all` over independent reads, the re-read-past-the-end pattern from `fetchRolePage`, and Suspense for below-the-fold parts:
  - `/companies`: `listCompanies(page)` beside `companyCount` (`companies/page.tsx:46-48`);
  - `/suggestions`: all second-wave reads except `listResolvedSuggestions` into the first `Promise.all` (`suggestions/page.tsx:119-124`);
  - `/admin/catalogue`: three waves to one plus one (`admin/catalogue/page.tsx:24-27`);
  - `/applications`: stream CV quotes via a `<Suspense>` child fed by `pipelineCvQuotes(user.id, keys)`, and fold `pipelineStageCounts` with the page keys into one `with idx as (…)` (`applications/page.tsx:66`);
  - layout Health count: fold `accountAiBudget` into the count if it can be a CTE (`lib/queries/health.ts:1223-1246`).
- Status: done [V] (commit ed79420): statements per full render on an ava_perf_bench clone /companies 14 → 13, /suggestions 11 → 10, /admin/catalogue 12 → 11, /applications 18 → 16; sequential RT at +100 ms per packet /companies 6.0 → 5.2, /suggestions 4.9 → 3.8, /admin/catalogue 5.9 → 4.3, /applications 7.9 → 6.5 total and 8.0 → 3.6 to the table (quotes stream behind it) [M].
- Impact: one RT per page (estimate), about 3–4 RT on `/applications` [M B #7].
- Effort: S each, M for `/applications`. Risk → guard: low; the re-read pattern is tested in `fetchRolePage`.

**3.12 Worker memory: compile ahead of time and close an idle browser.**
- Mechanism: bundle the worker with esbuild at image build and run `node dist/…` instead of `tsx`; close the Chromium instance (never closed once launched, `browser.ts:117-140`) after about 5 idle minutes and relaunch on demand.
- Status: done [V] (commits df7f0f6, dba7c36): `apps/worker/build.mjs` (esbuild) in a Dockerfile build stage, `node --enable-source-maps --import ./dist/otel.mjs dist/index.mjs` (tracing bundled as `dist/otel.mjs` and preloaded, shared with the bundle); tsx kept for tests and the CLI; Chromium closed after 5 idle minutes and relaunched on demand. Local idle RSS 161–236 MB from source → 117–118 MB compiled (one reading 205 MB); boot to /healthz 1.8–2.6 → 1.0 s [M]. Image not built locally (no Docker daemon); the worker-image CI job builds and boots it.
- Effort: M. Risk → guard: relaunch latency on the first browser task after idle (seconds); keep `BROWSER_CONCURRENCY=1` and the worker image CI job.

**3.13 CV PDF: keep the bytes that finalising already renders.**
- Mechanism: store the output of `finaliseCvDraft` (`app/actions/cv.ts:797`, rendered and discarded today) in `cv_pdfs(draft_id, content_hash, bytes)` or a `bytea` column; serve downloads from it and have "record application" copy it (`app/actions/applications.ts:279`); render on request only for previews. Finalised revisions are immutable (SPEC), so the key never goes stale. Lazy pdfkit import: see 4.5.
- Status: done [V] (commit 8068ad5): migration 0044 `cv_pdfs(draft_id, user_id, content_hash, bytes, created_at)` (a table, not a `cv_drafts` column, so `select *` on drafts stays small); finalise stores, the download serves on a matching sha256(commit + content) and renders-and-stores otherwise, record-application copies. Stored read 0.40 ms against a 15 ms warm / 49 ms first render and +27 MB RSS [M].
- Impact: short CV render 117 ms first, 11–34 ms warm, +26 MB RSS per render [M G3-backend]; long CVs take "seconds" per code comments.
- Effort: M. Risk → guard: stored bytes out of step with content; store the content hash and re-render on mismatch.

**3.14 Triage action: decide whether `decide` keeps `revalidatePath`.**
- Mechanism: any `revalidatePath` in an action sets `pathWasRevalidated` and the response carries a root render (`action-handler.js:773`); `revalidateDecided()` covers `/`, `/applications`, `/companies`, `/companies/[id]` (`app/actions/decisions.ts:106-111`). Option B: return `{ok, counts}` from the same `roleCountsFor` query, apply the existing optimistic removal plus counts, keep revalidation on undo and bulk actions.
- Status: option A (full render) in place [V].
- Impact: 92,856 B and 26–27 statements per decision today [M A-after]; option B about 0.5 KB and 4 statements (estimate).
- Effort: M. Risk → guard: stale banner and Health counts until the next navigation; add a test that tab counts move. Keep A until 3.2 and 3.5 land, then re-measure.

**3.15 Send background scoring through the Message Batches API.**
- Mechanism: `client.messages.batches.create({ requests: [{ custom_id, params }] })` at 50 % of standard token prices, cached tokens included; most batches finish within an hour, 24 h maximum; key results by `custom_id` (`taskId:userId:jobId`). A worker task collects `score_job` (A5) rows every N minutes and a poll task applies results; then A4 and A9. The A5 cached prefix must reach the scoring model's 1,024-token caching minimum; the system prompt is about 600, so an empty profile does not cache (harmless).
- Status: done [V] (commit this PR) for A5, behind the `scoringMode` system setting (default `live`, flipped on Admin › System settings › Scoring; collection every `scoringBatchMinutes`, default 10). After: batched A5 requests are held and recorded at 0.5× the standard price, every token including cache writes and reads (unit-tested); no production spend measured yet — the saving shows on Operations' A5 line once batch mode is on. A4 and A9 stay live: each is one step inside a handler that acts on its answer at once, not the scoring handler's shape.
- Impact: −50 % on A5, A4 and A9 spend (estimate); scores arrive minutes to an hour later. The model only ranks within the user's gate, so a delayed score changes ordering, never table membership.
- Effort: M–L. Risk → guard: expired or errored results requeue as ordinary `score_job` tasks; budget holds reserved per batch and released on result or expiry; A6, A11, A12 and CV stay synchronous.

**3.16 Skip the claim's `fair` CTE on non-CV lanes.**
- Mechanism: build the fairness CTE only when the lane is `cv`; it scans the CV backlog on every scan-lane claim.
- Status: done [V] (commit e974383): the `fair` CTE only where a CV build can be claimed. Prepared scan-lane claim on ava_perf_infra planning 0.644 → 0.258 ms, execution 0.275 → 0.172 ms; buffers 124 either way on that fixture (no builds waiting) [M].

**3.17 Batch the remaining per-row worker writes.**
- Mechanism: `enqueueTasks()` and multi-row `insert into tasks … values (…),(…) on conflict do nothing` in `handlers/companies.ts:154-166` and `:266-272`, `external-sources.ts:116,165`, `daily.ts:88-90`.
- Status: done [V] (commit a5d4e79): suggestions, profile queueing, source monitoring, document extraction and the logo sweep insert and enqueue per batch (`enqueueTasks`, multi-row inserts); six profiles one insert instead of six (test).
- Impact: tens of statements per discovery or suggestion run, not user-visible (estimate). Effort: S. Risk → guard: `enqueueTasks` already dedupes within a batch; keep the queue tests.

#### Already in place

- **3.18 PR #81** [V, M A-after]: one render per write; optimistic decisions; per-request `cache()` dedupe; combined shell statement; slim `countRoles`; per-source LATERAL for the newest scan; company page in two streamed halves; CV page in one wave; ids-only `roles` token; zod off three routes.
- **3.19 Offset pagination kept for the UI** [V]: every sort key is computed (status bucket depends on `now`, `fit_score nulls last`), so no index delivers the order. Offset 0 / 450 / 4,950 / 9,900 at 10k: 131–205 / 150–155 / 229–241 / 219–221 ms [M]; with 3.5 a deep offset costs only the narrow sort. Keyset already serves streamed CSV export (`fetchRoleRows({after})`, `jobs.ts:645`).
- **3.20 Scan write path batched, change detection pure** [V] (`handlers/scan.ts:678-973`, `packages/core`).

#### Evaluated and not recommended

- Keyset pagination for the table: loses "page 7 of 20" and breaks when `now` moves a row between buckets.
- Moving PDF rendering to the worker: 11–34 ms warm renders do not justify a queue hop.
- Batch claims: one slot runs one task.

### 4. Infrastructure & Data Layer

Production (read-only, 2026-09-27) [V]: Postgres 16 on `basic-256mb`, `shared_buffers` 64MB, `work_mem` 1654kB, `max_connections` 103, `random_page_cost` 1.1, role-level `statement_timeout` 30s and `idle_in_transaction_session_timeout` 1min, database 55 MB, 2 connections open idle. Local measurements use `ava_perf_infra` (148,000 postings, 60,000 tasks, 130,000 `job_events`), `EXPLAIN (ANALYZE, BUFFERS)`, median of 5, `work_mem = 1654kB` [M G4].

**4.1 Budget PostgreSQL backends, not PgBouncer client slots.**
- Mechanism: append `application_name=ava-web` / `ava-worker` to each `DATABASE_URL` (node-pg reads it; PgBouncer tracks it in transaction mode); keep `WEB_DB_POOL_MAX × peak concurrent web instances ≤ 60`; alert at 80 client backends (`select count(*) from pg_stat_activity where backend_type = 'client backend'`; delivery in 5.5). Optional: `CREATE ROLE ava_web LOGIN … CONNECTION LIMIT 60` [I: whether Render lets the default user create roles is unverified].
- Arithmetic:
  - Render PgBouncer: `pool_mode = transaction`, `default_pool_size = max_db_connections = 93`, `max_client_conn = 30000`, `client_idle_timeout = 86400` (Render docs); `max_connections` 103 confirmed in production [V].
  - Client slots (6 per warm instance plus 6 for the cron fallback) are not a limit.
  - Backends are: 93 via PgBouncer plus the worker's 26 direct = 119 > 100 usable (103 − 3 reserved).
  - PgBouncer keeps server connections for `server_idle_timeout` (default 600 s [I: not exposed by Render]), so after a web burst a worker reconnect, migration or `psql` can fail with `sorry, too many clients already` for up to 10 minutes.
  - About 67 simultaneous web transactions (12 instances × 6) reach it [I]; observed live peak 8 [M HOSTED-CAPACITY].
- Status: done [V] (commit b6c5aea): `application_name` `ava-web` / `ava-worker` / `ava-web-cron` via pg's option (a URL value wins); `databaseBackends()` exported from `@ava/db` for 5.5; cap 60 and alert 80 in DEPLOY.md. Separate role not done (M, Render permission unverified).
- Impact: prevents an outage that hits every account at once. A scan that cannot connect is a failed scan, never a closure, because only a successful scan closes a role; but CV builds and claims stall.
- Effort: S (tagging, alert), M (separate role). Risk → guard: a role limit fails web transactions first, which retry; `WEB_DB_POOL_MAX` stays the fast lever (DEPLOY.md step 5).

**4.2 Move the worker to Render Standard (1 CPU, 2 GB) with an explicit heap cap.**
- Mechanism: `render.yaml` `plan: standard`, `NODE_OPTIONS=--max-old-space-size=896` so V8 aborts before the cgroup kill, leaving about 1.1 GB for Chromium, `tsx` and native buffers. Keep `WORKER_CONCURRENCY=3` and `CV_CONCURRENCY=8` until a soak peaks below 70 % (1.4 GB), then try 6. Render has no 1 GiB step [I: check the dashboard].
- Status: not done [V]: Starter (0.5 CPU, 512 MiB), `NODE_OPTIONS` unset (production check 2026-09-27; DEPLOY.md rightly leaves it unset on Starter).
- Impact: 512 MiB fails the 70 % gate (466.8 > 358.4 MiB); 1 GiB passes (411.1 < 716.8) [M CAPACITY-AND-RECOVERY-DRILLS]. Base 140–168 MB idle, a scan adds 23–53 MB heap, a 41 MB board is about 80 MB as a string, heap ceiling 259 MB today. Removes the cgroup-OOM class behind the 20 September 06:11 exit [I]. CPU peaked at 0.108 and is not the reason. Cheaper levers first if cost matters: 3.12.
- Effort: S (about $25 a month instead of $7). Risk → guard: a cap too high reproduces the silent kill, too low aborts early; the boot line logs `heapLimitMb`; alert on unclean exits whose last heap reading was below 85 %.

**4.3 Per-table autovacuum for the high-churn tables (migration 0043).**
- Mechanism: `ALTER TABLE … SET` takes `SHARE UPDATE EXCLUSIVE`, blocking neither reads nor writes:
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
  `tasks` rewrites indexed `status` on every claim and finish; at the default 0.2 on about 60,000 rows vacuum waits for 12,000 dead tuples, roughly 3 days of 1,000-company churn. `user_jobs` is rewritten on every rescore (`fit_score` is in `user_jobs_table_idx`).
- Status: done [V] (commit 4c7a117): migration 0043, checked by `storage-parameters.test.ts`. After: a 60,000-row queue table with 4,000 dead status tuples was autovacuumed within 15 s tuned; the default table still held 4,000 dead 85 s later (threshold 1,700 vs 12,050).
- Impact: scan-lane claim 88 buffers clean, 277 after 8,008 dead tuples, 92 after `VACUUM` [M]; claim cost stays flat through the daily fan-out (poll rate: 3.6).
- Effort: S. Risk → guard: more vacuum I/O on a small instance, seconds per run at these sizes [I]; watch `select relname, last_autovacuum, n_dead_tup from pg_stat_user_tables`; revert with `ALTER TABLE … RESET (…)`.

**4.4 Run `ANALYZE` after bulk loads, restores and plan-test fixtures.**
- Mechanism: `ANALYZE companies, career_sources, company_subscriptions, user_jobs` from the worker after a bulk company import and after a `reevaluate_gate` touching over 500 jobs; `vacuumdb --analyze-in-stages` after every `pg_restore` in `scripts/recovery-drill.mjs` and the managed-restore runbook (PG16's `pg_restore` restores no statistics); `ANALYZE <tables>` in any plan-asserting test after its fixture load.
- Status: done [V] (commit a6a965d): `apps/worker/src/analyze.ts`; `reevaluate_gate` analyses `user_jobs` after writing over 500 views, `cli add` of over 50 companies analyses the four named tables; `vacuumdb --analyze-in-stages` after both restores in `scripts/recovery-drill.mjs` and in the restore runbook; `indexes.test.ts`'s plan helper and the dedupe plan test analyse after load.
- Impact: avoids hours of misplanned queries after an import or restore [I]; removes the flaky plan-test class [V].
- Effort: S. Risk → guard: never inside a request or server action transaction; run from the worker after the import task.

**4.5 Load pdfkit only inside the actions that render a PDF.**
- Mechanism: replace module-scope `import { renderCvPdf } from "@/lib/cv-pdf"` in `app/actions/cv.ts:5` and `app/actions/applications.ts:10` with `const { renderCvPdf } = await import("@/lib/cv-pdf")` inside the two actions.
- Status: done [V] (commit 8068ad5): `await import("@/lib/cv-pdf")` inside `finaliseCvDraft` and `recordApplication`. A fresh `next start` per page (entry preloading off) no longer loads pdfkit or fontkit rendering /settings, /library or /cv/[id] (it did before) [M]. The `.nft.json` files still list pdfkit for those pages, because the dynamic import's chunk is traced; dropping it from their packages needs those two actions in modules only the CV client components import.
- Impact: module load measured 808 ms and +57 MB under `tsx` [M G3-backend, an upper bound including transpilation]; local cold first request 1.9–2.3 s [M A-baseline §6]; the pdfkit share on Vercel is unmeasured [I: profile a cold `/applications` before claiming it]. Smaller function packages regardless.
- Effort: S. Risk → guard: `pnpm smoke:web` exercises the PDF download and record-application path.

**4.6 Vercel function settings: Node 22, `maxDuration` on PDF and import routes, `after()` for the session touch.**
- Mechanism:
  - Set the project's Node.js version to 22.x: the dashboard shows 24.x, `apps/web/package.json` declares `"node": "22.x"` and the worker runs 22; `engines` applies only when the project setting does not override it.
  - Add `export const maxDuration = 30` to `api/cv/[id]/pdf`, `api/cv/preview`, `api/applications/[id]/pdf` and the `/cv/[id]` page (its `recordApplication` action renders a PDF), and `60` to `api/cv/library/imports` (up to 5 MB parsed).
  - Wrap `lib/auth.ts:36`'s `void db().update(sessions)…` as `after(() => …)`; Next 15's `after` maps to Vercel's `waitUntil`, as `app/login/actions.ts:96,125` already use.
- Status: done [V] (commit aaeb29a): `maxDuration` 30 on the three PDF routes and `/cv/[id]`, 60 on `api/cv/library/imports`; session touch via `after()`; DEPLOY.md tells the operator to set the project's Node.js version to 22.x (a dashboard change, not made here).
- Impact: a pathological document costs 30 s of GB-seconds, not 300; the hourly session write can no longer be lost when an instance freezes after the response.
- Effort: S each. Risk → guard: 30 s is 10× the render limit in `cv-render-limit.ts`; the smoke test downloads a PDF.

**4.7 Disk: 15 GB with autoscaling, and clear old scan snapshots.**
- Mechanism:
  - (a) Set the live database to 15 GB with storage autoscaling; `render.yaml`'s `diskSizeGB: 15` does not apply because the services are not blueprint-linked. Alert at 70 % (5.5).
  - (b) Add a rule to `RULES` in `apps/worker/src/maintenance.ts`:
    ```sql
    update scans set raw_snapshot = null where id in (
      select s.id from scans s
      where s.raw_snapshot is not null and s.started_at < now() - interval '7 days'
        and not exists (select 1 from (select id from scans r where r.source_id = s.source_id
                          and r.status in ('ok','partial') and r.raw_snapshot is not null
                          order by r.started_at desc limit 1) keep where keep.id = s.id)
      limit $n)
    ```
  - Every reader takes only the newest snapshot per source (`handlers/scan.ts:1055`, `handlers/suggest-from-scans.ts:68`); the interface never selects it.
- Status: (b) done [V] (commit 5cb3b43), keeping the newest `ok` scan's snapshot as well, which `readLastOkSnapshot` reads; with `scans_snapshot_idx` (0043): clear 2,380 snapshots 622 → 109 ms, idle hour 339 → 0.6 ms on `ava_perf_infra`. Note: scans already keep at most 4 snapshots per source (`handlers/scan.ts:926`), so the 1.8 GB estimate overstated growth. (a) not done: a dashboard change; DEPLOY.md says so.
- Impact: snapshots are the largest grower: at an assumed 20 KB × 1,000 sources × 90 days ≈ 1.8 GB, cut to ≈ 160 MB [I]. Measure first: `select count(*), pg_size_pretty(sum(pg_column_size(raw_snapshot))) from scans;`. A full disk stops every write, sign-ins included.
- Effort: S each. Risk → guard: keeps the latest successful snapshot per source, which closure reuse and suggestions read; add a `maintenance.test.ts` case.

**4.8 Set `jit = off` for the database.**
- Mechanism: `ALTER DATABASE ava SET jit = off;` Do not set `idle_session_timeout`: it would kill PgBouncer's idle server connections.
- Status: done [V] (commit 4c7a117): `ALTER DATABASE <current> SET jit = off` in 0043, skipped with a NOTICE when the migrating role does not own the database. Impact: no captured plan crosses `jit_above_cost` (100,000; largest about 10,000) today; a catalogue-wide admin or export query at scale would pay 50–200 ms to compile [I]. Effort: S. Risk → guard: revert with `ALTER DATABASE ava RESET jit`.

**4.9 Leave `basic-256mb` at a stated threshold.**
- Mechanism: move to `basic-1gb` (`shared_buffers` about 256 MB) when `select sum(heap_blks_hit)::float / nullif(sum(heap_blks_hit + heap_blks_read), 0) from pg_statio_user_tables` falls below 0.99 over a day, or `pg_total_relation_size('user_jobs') + pg_indexes_size('jobs')` exceeds about 150 MB (≈ 700 accounts at 1,000 views).
- Status: not done [V]: `shared_buffers` 64MB today; database CPU peaked at 15 %, memory 55 % [M HOSTED-CAPACITY]. Sizes: `user_jobs` 185 B per view, `job_events` 259 B, `tasks` 398 B, `jobs` 536 B per posting [M].
- Impact: keeps per-account index probes in memory; 1,000 cold `jobs_pkey` probes at 1–5 ms would cost seconds [I]. Effort: S. Risk → guard: a restart of a few minutes; do it outside the daily run after a restore point.

**4.10 Audit unused indexes after 14 days of production traffic.**
- Mechanism: `select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) from pg_stat_user_indexes where relname in ('tasks','jobs','job_events','user_jobs') order by idx_scan;`. Fixture candidates with `idx_scan = 0`: `jobs_first_seen_idx` (4.2 MB), `jobs_company_status_idx` (1.4 MB), `tasks_scan_run_idx` (2.2 MB, indexes every task).
  - If the last stays: `CREATE INDEX CONCURRENTLY tasks_scan_run_p_idx ON tasks ((payload->>'scanRunId'), status) WHERE payload->>'scanRunId' IS NOT NULL;` then `DROP INDEX CONCURRENTLY tasks_scan_run_idx;` (readers `handlers/daily.ts:115`, `scan-summary.ts:71` imply `IS NOT NULL`).
  - Keep `job_events_job_idx`: it serves the `ON DELETE CASCADE`.
- Status: not done [V]. Impact: fewer index writes per task insert and claim on a 13-index table [I, small]. Effort: S. Risk → guard: drop only what shows 0 over a weekly cycle and has no code reader; `indexes.test.ts` names each index's reader; `SET statement_timeout = 0` first for `CONCURRENTLY`.

#### Already in place

- **4.11 `random_page_cost = 1.1`** (done in production [V]). The roles page at 148,000 postings runs 317.8 ms at 4 and 20.0 ms at 1.1; count 11.4 → 5.8 ms; the 96-statement sweep 875.6 → 177.8 ms, worst regression +0.5 ms [M G4]. That is the gain production already has; 3.5 fixes the underlying misestimate.
- **4.12 Role-level timeouts** (done in production [V]): `statement_timeout` 30s and `idle_in_transaction_session_timeout` 1min, as `docs/DEPLOY.md:104-116` instructs. They are the only bound on the interface: the web's own 30 s values are dropped on 6432 (`serverTimeouts()` returns `{}`).
- **4.13 Index coverage after 0042** (done [M]): every hot path is index-driven: roles page `user_jobs_table_idx` → `jobs_pkey` (Memoize); claims on `tasks_lane_idx`, `tasks_cv_running_user_idx`, `tasks_status_run_after_idx` (0.7–1.8 ms); status strip `scans_source_completed_idx` (2.5–5 ms); recent events `Index Scan Backward` (1.7–2.3 ms for 50 roles). No new composite index is needed.
- **4.14 Retention and HOT updates** (done [M]): hourly prune, 5,000 rows per statement, 20 s per table (`maintenance.ts`); 5,000 `job_events` in 37 ms, a scans batch in 146 ms at 1,000 sources. Lease renewals are HOT (1,096 of 1,100); no `fillfactor` change needed.
- **4.15 Multi-instance safety primitives** (done [V]): `FOR UPDATE SKIP LOCKED` claims (`queue.ts:191,200`), owner-and-attempt fencing, 30 s leases with `workerId = RENDER_INSTANCE_ID` (`env.ts:77`), advisory locks for the weekly jobs, daily fan-out and gate re-evaluation, `settings`-row claims for maintenance and ticks (`scheduler.ts:187`).

#### Evaluated and not recommended

- Read replicas now: nothing is both heavy enough and safe to read stale. Per-account data never goes to a replica, and neither does anything the worker reads to reconcile a scan (only a successful scan closes a role), the claim and leases, budget reservations, `getCurrentUser()`, or any render after a write (#81's one render per write needs read-your-writes). Only shared admin aggregates (Operations, `listLargestScanInputs`) could move later, when primary CPU exceeds 60 % sustained and they exceed 30 % of total time in `pg_stat_statements`, with lag monitoring and fallback to the primary above 10 s.
- Raising `work_mem`: 0 of 96 captured statements spilled at 1654kB and the largest sort is 66 kB [M]; only a 10,000-role deep offset spills (`external merge 4096kB`), which 3.5 shrinks. Watch `select temp_files, temp_bytes from pg_stat_database where datname = current_database()`.
- A second worker instance now: it adds 26 direct backends (52 + 93 against 100), runs a second Chromium and a process-local `verify_company` cap, and `worker-release` polls one instance behind the balancer. Scale vertically (4.2) and ship 4.1 first; then keep `instances × (2 × slots + 4) ≤ 30`.
- Vercel Performance tier (2 vCPU / 4 GB): `/api/health` used 228 MB and a 100-session burst peaked at 635 MB [M HOSTED-CAPACITY].

### 5. Automated Performance Testing & Monitoring

Today [V]: four CI jobs, wall clock 8m17s (`check` 8m14s, of which `pnpm -r test` 6m49s), none measuring performance (`.github/workflows/ci.yml`, run 36269891342). `operational-status.yml` samples the worker's `/status` every 15 minutes against seven thresholds (`scripts/release-checks.mjs:19-31,170-217`). `benchmark-users.mjs` and `cv-load.mjs` run by hand. No APM, tracing or Web Vitals library anywhere.

**5.1 Commit a per-route bundle-budget gate in `browser-and-smoke`.**
- Mechanism: `scripts/bundle-budget.mjs` reads `apps/web/.next/app-build-manifest.json` `.pages` and `build-manifest.json` `.rootMainFiles`, unions root files, `/layout`, `/(app)/layout` (plus `/(app)/admin/layout`) and the page's `.js`, gzips at level 9 (`zlib.gzipSync`) and compares with `scripts/bundle-budget.json`.
  - Budgets (bytes, A-after + about 3 %): `/cv/[id]` 138,000; `/companies/[id]` 130,000; `/library` 129,000; `/` 128,000; `/applications` 123,000; `/suggestions` 120,000; `/settings` and `/companies` 117,000; `"*"` 115,000; shared root 104,000.
  - Also fail when a chunk over 20 KB gzip newly enters a first load (the 23.8 KB zod chunk).
  - Write the table to `$GITHUB_STEP_SUMMARY`; add `bundle-budget.test.mjs` with a synthetic manifest.
- Status: done [V] (commit 0d2baec). Every route passes on this branch's build: `/cv/[id]` 133,180 B gzip (budget 138,000), `/companies/[id]` 126,812, `/` 124,603, shared root 102,301 (104,000); 0.15 s of CI.
- Impact: stops silent first-load growth (the roles table already grew 2 KB gzip since A-after); under 2 s of CI (estimate).
- Effort: S. Risk → guard: raise the budget in the same PR so the diff records the decision; compare by route, never by chunk name.

**5.2 Show the vitals the worker already writes, and gate on them.**
- Mechanism: read `eventLoopLagP99Ms`, `slowQueries` and `db.{total,idle,waiting}` in `readVitals` (`apps/web/lib/queries/health.ts:393-407`) and `readOperationalSample` (`release-checks.mjs:130-165`), optional in both; compare first and last `slowQueries` samples for the delta.
- Status: done [V] (commit a425e53). Read in `readVitals` and `readOperationalSample` as optional fields, shown on Operations › Background worker; the gate warns at 200 ms loop lag and 20 slow queries, fails at 1,000 ms in 2 samples and 100; a sample without the fields passes.
- Impact: event-loop stalls and pool waits visible without a metrics stack. Effort: S. Risk → guard: a `release-checks.test.mjs` sample without the fields still passes.

**5.3 Install `pg_stat_statements` and read it from the CLI and Health.**
- Mechanism: a migration `do $$ begin create extension if not exists pg_stat_statements; exception when insufficient_privilege then raise notice 'skipped'; end $$;`; `pnpm cli pgstat [--reset]` and an admin-only card selecting `calls`, `total_exec_time`, `mean_exec_time`, `stddev_exec_time`, `shared_blks_hit/read`, hit %, and `left(query,160)` for the current `dbid`, ordered by total time, top 20; weekly `pg_stat_statements_reset()` after 5.8 snapshots it.
- Status: done [V] (commit fb79bfb). Migration 0045 installs it where the role may and skips with a notice where it may not; `pnpm cli pgstat [--reset]` and the admin-only Costliest statements card say "installed but not loaded" or "not installed" instead of failing. The weekly reset stays manual: the weekly audit (5.8) runs against a scratch database, not production.
- Impact: production cost by total time for the shell statement (0.8–4.7 ms) and roles query (12.5 ms) [M A-after]; the before/after check for 3.5, 3.7 and 4.3. Overhead about 1–2 % CPU (estimate).
- Effort: S. Risk → guard: literals in text; Drizzle and `pg` parameterise, the card is `requireAdmin`, truncated and never logged.

**5.4 Collect real-user Core Web Vitals through the existing beacon, sampled and identifier-free.**
- Mechanism: `NavigationMetrics.tsx` uses `web-vitals@5` `onLCP/onINP/onCLS/onTTFB/onFCP` (or `next/web-vitals` `useReportWebVitals`), samples `Math.random() < 0.25` per load, batches one `navigator.sendBeacon('/api/performance', …)` on `visibilitychange === 'hidden'` with `{route, metric, value, rating, navType, deviceClass, effectiveType}` and no user id, session, email, IP, query string or full URL.
  - `/api/performance` keeps its signature check and upserts `web_vitals(day, route, metric, bucket, count)` log-bucketed histograms; 90-day retention; Health shows p75.
- Status: done [V] (commit cf0145c). 25 % of loads, lab browsers excluded, the library loaded only on sampled loads (+266 B first-load gzip instead of +3,070 B), one beacon on hide; extra keys refused with 400; histograms in `web_vitals`, 90-day prune in the monitor task; p75 per route on Operations.
- Impact: the only field INP/LCP source; beacon invocations −75 % (from the sample rate). Effort: S–M. Risk → guard: route returns 204 even if the insert fails; the route test rejects any extra key with 400.

**5.5 Concrete alert thresholds with a delivery channel.**
- Mechanism: a `monitor_sample` worker task every 5 min writes `settings['internal:monitor']`, exposed on Health and `/status` so the 15-minute gate enforces it; GitHub notifications on failed `operational-status.yml` runs and Render notifications (deploy failed, unhealthy, restarted) go to the alert owner. Thresholds:

  | Signal | Warn | Fail | Source |
  |---|---|---|---|
  | Worker heap fraction | ≥ 0.75 in 2 of 3 samples | ≥ 0.85 in 2 (exists) | heartbeat `vitals.heapFraction` |
  | Event-loop lag p99 | ≥ 200 ms | ≥ 1,000 ms in 2 samples | `vitals.eventLoopLagP99Ms` (5.2) |
  | Worker pool waiting | > 0 in 1 sample | > 0 in 2 (exists) | `vitals.db.waiting` |
  | Postgres active backends | ≥ 60 % of usable | ≥ 80 % (4.1) | `pg_stat_activity where state <> 'idle'` |
  | Oldest ready task | ≥ 5 min | ≥ 15 min (exists) | `/status metrics.oldest_seconds` |
  | Daily scan failures | ≥ 10 % of sources | ≥ 25 %, or ≥ 10 overdue (exists) | `scans.status <> 'ok'` for today's runs |
  | Model 429/529 rate | ≥ 5 % in 1 h | ≥ 20 %, or an outage group (exists) | `ai_calls.error` [I: error text unverified] |
  | Slow queries | Δ ≥ 20 per 15 min | Δ ≥ 100 | `vitals.slowQueries` delta |
  | Disk | 70 % | 85 % | Render Postgres metrics |
  | Buffer hit ratio | below 0.99 over a day | none | 4.9 query |
  | Unclean exit | any | last heap reading below 85 % (cgroup OOM, 4.2) | worker events |
- Status: done [V] (commit 8ea4cdc) for every row the worker can read: heap, lag, pool waits, backends, oldest task, scan failures, 429/529 share and slow queries sampled every 5 min into `settings['internal:monitor']`, served on `/status`, gated (warnings never fail) and shown on Operations › Alert signals. Disk, buffer hit ratio, unclean exit and PgBouncer clients stay Render notifications, documented in DEPLOY.md › Alert ownership with the GitHub delivery settings.
- Impact: detection within 15 minutes. Effort: M. Risk → guard: alert fatigue on deploys; keep the 2-sample rule and `deployGraceSeconds`; warnings do not fail the run.

**5.6 Lighthouse CI on pull requests.**
- Mechanism: `@lhci/cli@0.14` job against a seeded `next start` on port 3124 (cookie via `extraHeaders`), URLs `/`, `/companies`, `/library`, `/cv/${DRAFT_ID}`, 3 runs, desktop, `median-run`: LCP ≤ 2,500 ms, CLS ≤ 0.1, TBT ≤ 200 ms (error), interactive ≤ 3,800 ms and server response ≤ 600 ms (warn), `resource-summary:script:size` ≤ 140,000 with an `assertMatrix` holding `/` to 130 KB.
  - A mobile preset at `warn` until two weeks of history.
  - A second pass on the Vercel preview (`deployment_status`, `x-vercel-protection-bypass`) only if Preview has its own `DATABASE_URL` and `SESSION_SECRET`, never production; otherwise `/login` signed out.
- Status: done [V] (commit 3d7abd5). Local desktop medians: LCP 612–702 ms, TBT ≤ 25 ms, CLS ≤ 0.008; script transfer is Next's compression, not gzip-9, so the assertions are 134,000 B on `/` (measured 133,772) and 145,000 elsewhere (`/cv/<id>` 138,320). Mobile warns (LCP 2.6–2.8 s, `/library` TBT 320 ms). Preview pass behind `LHCI_PREVIEW_ENABLED`. Impact: catches LCP/CLS/TBT regressions before merge; about 3 min of CI (estimate). Effort: M. Risk → guard: runner noise; 3 runs, error only on desktop, delete the seeded account in a `finally`.

**5.7 Correct the capacity probe's poll model and run it weekly.**
- Mechanism: import `nextPollDelay`, `FIRST_POLL_MS`, `LONGEST_POLL_MS`, `BANNER_FIRST_MS` from `apps/web/lib/polling.ts`; split the window into `idle` (assert 0 requests), `pre-scan` (banner to 60 s) and `run` (backoff polls plus an `RSC: 1` refresh of `/`, 23 KB, with 10 % of tabs on Matched, 80 KB); stand-in worker finishes a company every 12 s with a calibration check of 2.3–3.3 refreshes per tab per minute; assert the sequence `[10000, 15000, 22500, 33750, 50625, 60000]`; weekly `cron "17 3 * * 1"`; add `refreshP95Ms: 2000` to `TARGETS`.
- Status: done [V] (commit 8542c67), with an open finding: idle 0 requests, pre-scan as modelled, run 5.2 status polls, 1.5–1.8 banner polls and 3.52 refreshes per tab-minute (about 1,050 requests and 6,600 transactions per minute per 100 tabs) at 60 s and 150 s windows, so the calibration check (2.3–3.3, D's single browser tab) fails until the difference is explained; the weekly run will open an issue for it.
- Impact: the busy projection becomes about 880 requests/min and 7,400 queries/min per 100 tabs [M D], the figure 4.1 sizes against. Effort: M. Risk → guard: the weekly job opens an issue instead of blocking merges.

**5.8 Weekly re-run of the audit measurements from `scripts/perf/`.**
- Mechanism: commit `fixture.mjs`, `pages.mjs` (p50/p95, HTML, gzip and RSC bytes, statements per request from the `pg_stat_statements` `calls` delta), `roundtrips.mjs` (effective sequential RTs at +20 ms per packet), `decide.mjs` and 5.1's script, each with `node --test` units; a weekly `cron "23 4 * * 1"` compares with `scripts/perf/baseline.json` (`/` 14 statements and 4.4 RT at pool 6; `/companies/<id>` 26 and 7.6) and fails on +1 statement, +1 RT or +10 % bytes.
- Status: done [V] (commit d61b7fd). Statements are counted on the wire (no log setting, no preloaded extension) and match A-after on all 15 paths; round trips `/` 4.5 (4.4), `/companies/<id>` 7.6 (7.6); one decision 1 request, 93,085 B, 28 statements. Round trips are the lower of two passes because host load inflated one pass by up to 1.6.
- Impact: counts are deterministic where ms on shared runners is not. Effort: M. Risk → guard: update `baseline.json` in the PR with the reason.

**5.9 Distributed tracing on three spans, sampled at 10 %.**
- Mechanism: `apps/web/instrumentation.ts` with `registerOTel({ serviceName: 'ava-web', traceSampler: 'traceidratio' })`, `OTEL_TRACES_SAMPLER_ARG=0.1`, `@opentelemetry/instrumentation-pg` with `enhancedDatabaseReporting: false`.
  - Worker: `@opentelemetry/sdk-node` plus pg and undici instrumentation, manual spans `task.run`, `model.call` (model, call site, token and cache-read counts), `scan.fetch`; trace id in log lines via AsyncLocalStorage; no user id, email or CV text as attributes.
- Status: done [V] (commit 721b651), off by default (needs `OTEL_SDK_DISABLED=false` and an OTLP endpoint). The interface has Next's spans only: the web package has no pg instrumentation dependency. Impact: splits a slow page into DB wait and render (A-after §3 did it by hand: 45–57 ms render against about 18 ms SQL wall). Effort: M. Risk → guard: memory on the 512 MB worker; `maxQueueSize: 512`, ship with `OTEL_SDK_DISABLED=true` until an endpoint exists, watch heap for a week.

**5.10 Keep PR wall clock at or under 10 minutes as gates land.**
- Mechanism: 5.1 inside `browser-and-smoke` (about 4.5 min of slack against `check`); 5.6 as a parallel job reusing `.next/cache` with `timeout-minutes: 12`; 5.7 and 5.8 scheduled, not per PR.
- Status: done [V] (this PR). Bundle gate inside `browser-and-smoke` (0.15 s), `lighthouse` parallel with `timeout-minutes: 12`, the probe and the audit scheduled only; the budget is written down in DEPLOY.md › Continuous integration. PR wall clock not re-measured on a runner. Impact: no added PR latency (estimate). Effort: S. Risk → guard: none.

#### Evaluated and not recommended

- Porting `benchmark-users.mjs` and `cv-load.mjs` to k6: they seed Postgres, forge HMAC cookies, spawn `next start --inspect`, sample heap and `pg_stat_activity`, and run the real `TaskQueue`; k6 has no pg driver without xk6-sql and cannot import `lib/polling.ts`. k6 earns a place only for a 30-minute, 100-VU soak against a Preview-scoped database once one exists (thresholds poll p95 < 1,000 ms, refresh p95 < 2,000 ms, failures < 0.1 %).

### First ten

1. **3.1** Reuse the tab count on default views (S; −28 ms at 10k and a pool slot).
2. **3.2** Events off the table payload (S; −1 RT, −20 % of the rows prop).
3. **1.1** Assert `private, no-store` on every authenticated response (S; guards the worst failure).
4. **2.1** Drop Silkscreen 700 and use a monospace fallback (S; −3,208 B per hard load, lower CLS).
5. **5.3** Install `pg_stat_statements` (S; production numbers for every later change).
6. **4.1** Tag `application_name`, cap web backends at 60, alert at 80 (S; prevents a shared outage).
7. **4.3** Per-table autovacuum migration (S; claim buffers 277 → 92).
8. **3.3** Pool idle 120 s plus `attachDatabasePool` (S; 5–25 ms after each pause).
9. **3.5** Sargable roles predicates and deferred join (M; 131–205 → 41–44 ms at 10k).
10. **4.2** Worker to Standard 2 GB with a 896 MB heap cap (S; removes the cgroup-OOM class).
