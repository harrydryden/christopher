# G1 — Global and cross-cutting architecture

Legend: **[V]** verified in code, config or build output. **[M]** measured in audits A/B/C/D or the review docs. **[I]** inferred from platform behaviour. Production headers could not be fetched: the sandbox proxy returns 403 for `*.vercel.app`. Every [I] about Vercel's edge has a one-line check to run from a normal machine.

Response classes today (the basis for the items below):

| Class | Cache-Control today | Source |
|---|---|---|
| Authenticated HTML and RSC (`(app)/**`) | `private, no-cache, no-store, max-age=0, must-revalidate`; `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch` | [V] every `(app)` page and `(app)/layout.tsx:17` are `force-dynamic`; header from `next/dist/server/lib/cache-control.js:15`, Vary from `base-server.js:1145`; [M] A-baseline §1 |
| Auth pages (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/verify`) | same as above (`force-dynamic`) | [V] `app/login/page.tsx:9` and the others |
| `/share/[token]` | `private, no-store`, set by middleware | [V] `middleware.ts:31-35`, `app/share/[token]/page.tsx:33`; [M] `scripts/smoke-cv.mjs:957` |
| `/api/*` JSON and polls | `no-store` or `private, no-store` | [V] `api/work-status`, `scan-status`, `health`, `cv/*`, `export.csv`; 401s `private, no-store` (`lib/route-auth.ts:20`, `middleware.ts:44`) |
| CV and application PDFs | `private, no-store` | [V] `api/cv/[id]/pdf/route.ts:54` (re-rendered on every GET), `api/applications/[id]/pdf/route.ts:17` (stored bytes) |
| Company logo | versioned `?v=` URL: `public, max-age=86400, immutable`; otherwise `public, max-age=3600`; `ETag` from capture time | [V] `api/companies/[id]/logo/route.ts:41-47` |
| `_next/static/*` | `public, max-age=31536000, immutable` | [M] A-baseline §1 |
| `icon.svg`, `apple-icon.png` | `public, immutable, no-transform, max-age=31536000` | [V] `.next/server/app/icon.svg/route.js` |
| `favicon.ico`, `manifest.webmanifest`, `public/brand/*` | `public, max-age=0, must-revalidate` (Next/Vercel default for static files) | [V] favicon route build output; [I] brand and manifest |

---

- [ ] **G1. Keep per-account HTML and RSC uncacheable, and add a test that fails if that changes**
  - Mechanism: RFC 9111 `private` plus `no-store` on every authenticated page and every `RSC: 1` response. Vercel's CDN caches a function response only when it carries `s-maxage`, `CDN-Cache-Control` or `Vercel-CDN-Cache-Control` [I]. Next's `Vary` leaves out `Cookie`, which is correct only while pages stay `private, no-store`. Do **not** add `ETag`/304 to HTML, RSC or polls. A conditional GET still pays the full render to compute the hash, pages stream, and poll bodies are 61–149 B [M D-live].
  - Status: **done** for the headers [V]. **Not done** for the guard: `scripts/smoke-web.mjs` fetches every page with a cookie (`:195`) but checks no headers. Route tests cover the API only.
  - Change: in `smoke-web.mjs`, for every authenticated page and a `RSC: 1` refetch, assert that `cache-control` contains `private` and `no-store`, does not contain `public` or `s-maxage`, and that the response has no `set-cookie`. Keep an allow-list of public paths: the logo route, `_next/static`, metadata icons.
  - Impact: none on latency. It prevents the worst possible caching failure, one account's table served to another.
  - Effort: S. Risk: none.

- [ ] **G2. Cache versioned company logos on Vercel's CDN, not only in the browser**
  - Mechanism: when `?v=` matches the capture time, add `CDN-Cache-Control: public, max-age=31536000, immutable` (or `Vercel-CDN-Cache-Control`) and keep the browser `Cache-Control`. `max-age` alone is browser-only on Vercel [I]. The cache key includes the query string, so a re-capture changes the URL and busts the cache. Also move the `if-none-match` comparison ahead of the bytea read: select `fetched_at` first, then the bytes, so a 304 costs no blob transfer.
  - Status: **partial**. Browser caching is done (`logo/route.ts:46`). The CDN does not cache the logo. Every miss runs the Edge middleware, then a Node function, then `routeUser()` (the session join), then `readCompanyLogo` (bytea): 2 sequential DB round trips [V].
  - Impact: a cold browser on `/` requests up to 50 logos. They are lazy (`CompanyFavicon.tsx`), so about 15–20 are above the fold (estimate). A CDN hit removes the function invocation and both DB round trips for **every account** after the first fetch per edge region. The logos are shared catalogue data, so the hit rate grows with accounts. It also stops logo requests competing for the 6-connection pool while the user is navigating (estimate).
  - Option B (larger saving, needs a policy decision): drop `routeUser()`, exclude `api/companies/*/logo` from the `middleware.ts` matcher and serve logos fully public. That means zero invocations on a hit.
  - Effort: S. Risk: a revoked session whose cookie still has a valid signature can fetch a cached logo. That is acceptable, because the route already says "any cache may hold it" (`:43`). For an emergency takedown, use Vercel's cache purge or change `fetchedAt`. Guard: emit the CDN header only on the versioned 200 path, never on 404 or 304-without-body. Add a route test beside `logo/route.test.ts`.

- [ ] **G3. What else could the edge cache hold? (eligibility decided, mostly "no")**
  - `/share/[token]`: **must not** be cached. A revocation must take effect, and the page records views (`recordCvShareView`). Done: `private, no-store` [V].
  - Auth pages: could be prerendered, reading `searchParams` on the client, but each is one hit per sign-in, and `sessionSecret()`/`googleConfigured()` read env at request time. **Not recommended**: low value, and it would change how the error query string renders.
  - RSC for static segments: none exists. `(app)/layout.tsx` is `force-dynamic`, reads the session and renders per-account counts. PPR is canary-only on Next 15.5. **Not applicable.**
  - CV PDF: correctly `private, no-store`. An ETag keyed on draft id, content version and renderer build would allow a 304 without a pdfkit re-render, but downloads are rare and already rate-limited (`refuseCvRender`). **Not recommended now.**
  - `public/brand/*` and `manifest.webmanifest`: only the manifest's three icons use them [V `app/manifest.ts`], and they are fetched rarely. The default must-revalidate costs one 304 each. **Not applicable.** If more brand files are ever linked from pages, add a `headers()` rule for `/brand/:path*` with `public, max-age=86400, stale-while-revalidate=604800`.
  - `_next/static`, `icon.svg`, `apple-icon.png`: **done**, immutable for one year.
  - Effort: none. Risk: none.

- [ ] **G4. Compression: leave it to Vercel's edge (Brotli, falling back to gzip)**
  - Mechanism: Vercel's edge negotiates `Accept-Encoding: br` and compresses text types on the fly, including streamed HTML and `text/x-component` RSC [I]. Next's `compress: true` (`config-shared.js:60`) applies only to `next start`. Do not compress inside route handlers: if a handler sets `content-encoding`, the edge skips its own compression. PDFs (pdfkit deflates its streams) and logo images are already compressed, so leave them.
  - Status: **done by platform** [I]. Check with `curl -sI -H 'Accept-Encoding: br' https://<host>/login | grep -i content-encoding` and expect `br`.
  - Impact [M A-after §1]: `/` is 243,479 B of HTML, 22,117 B gzip (11×). The RSC refresh is 90,832 B raw. Brotli is about 10–15% smaller than gzip-9 (C-client). Payload *size* belongs to BACKEND and FRONTEND.
  - Effort: S (verify only). Risk: none.

- [ ] **G5. HTTP/2 and HTTP/3 on one origin: keep everything same-origin**
  - Mechanism: Vercel terminates TLS 1.3 and serves HTTP/2, advertising HTTP/3 (QUIC) through `Alt-Svc` [I]. One multiplexed connection carries the HTML, `_next/static`, fonts, RSC, actions, polls and logos. Fonts are self-hosted by `next/font` [V `app/layout.tsx`, C-client §CSS and fonts]. There are no third-party scripts [V C-client "Leaks: none"].
  - Status: **done**. Do not add an asset subdomain or a separate API origin: each one costs a DNS lookup, a TCP connection and a TLS handshake. The only cross-origin fetches are the favicon fallbacks in `lib/company-icon.ts` (stored URL, then `host/favicon.ico`, then DuckDuckGo). Each distinct host is a new connection, but they are lazy and off the critical path.
  - Recommendation: track logo capture coverage (captured logos are same-origin; see G2), not connection tuning. Check the protocol with the DevTools "Protocol" column (`h3`/`h2`) or `curl --http3 -I`.
  - Impact: about 1–3 third-party round trips per uncaptured company icon (estimate). No LCP impact.
  - Effort: S. Risk: none.

- [ ] **G6. Preconnect and 103 Early Hints**
  - Mechanism: `next/font` emits `Link: <…woff2>; rel=preload; as=font` on every HTML response. That is 5 files, 36,968 B [M A-baseline §4]. There is nothing to `preconnect` to: fonts and APIs are same-origin. Vercel does not send `103 Early Hints` for function responses [I; check for `HTTP/2 103` in `curl -v`]. The `Link` header therefore arrives with the first byte. The first byte waits for `(app)/layout` to resolve the session and the shell statement before the `loading.tsx` shell can flush.
  - Status: **not applicable** (the platform does not send 103). No `<link rel=preconnect>` exists, which is correct. Do not add preconnects to company or DuckDuckGo hosts: that would open up to 50 origins and waste sockets.
  - Real lever: shorten what gates TTFB, the layout's blocking round trips (BACKEND). Drop the Silkscreen 700 preload (FRONTEND; C-client #7).
  - Effort: none here. Risk: none.

- [ ] **G7. Region alignment and the round-trip budget**
  - Verified config: `apps/web/vercel.json` has `"regions": ["fra1"]`. In `render.yaml`, the database and the worker are both `frankfurt`. The worker is not on the request path: the interface only writes `tasks` rows (CLAUDE.md). The Edge middleware does HMAC only, with no database (`middleware.ts`, `lib/session.ts`). The Vercel↔Render link is the **public** External URL over TLS (`docs/DEPLOY.md:191`). There is no private network between the two providers.
  - Status: **done** in config [V]. **Unverified** in production. EFFICIENCY-REVIEW recorded the live function in `iad1` before `fra1` was set, and PERFORMANCE-REVIEW "Remaining" still asks for confirmation. Check the dashboard (Settings → Functions → Region) and look for `fra1` in the `x-vercel-id` of a page response.
  - Budget for a warm navigation, UK user (estimates except where marked):

    | Leg | Round trips | ms |
    |---|---|---|
    | Browser → Vercel PoP (warm h2/h3) | 1 | 5–20 |
    | PoP → fra1 function (Vercel backbone) | 1 | 10–20 |
    | Edge middleware (HMAC) | 0 DB | <1 |
    | Function → PgBouncer, sequential waves at pool 6 | 4.4 on `/`, 7.6 on `/companies/<id>` [M A-after §2] | × 1–5 ms per RT (assumed in A-baseline, never measured) = 4–38 |
    | New browser connection (cold) | +1 (QUIC) to +2 (TCP + TLS 1.3) | +10–40 |

  - Recommendation: measure the real fra1 → Render RTT once. Time a `select 1` on a warm pooled connection and log it at each instance's cold start (instrumentation belongs to TESTING & MONITORING). If it is above 5 ms, every sequential wave counts about 5× more than the audits assumed.
  - Effort: S. Risk: none.

- [ ] **G8. Database connection reuse from functions (TLS and PgBouncer handshakes)**
  - Mechanism: a new connection costs a TCP handshake (1 RT), the Postgres `SSLRequest` (1 RT), a TLS handshake (1 RT on TLS 1.3, 2 on 1.2) and PgBouncer startup plus SCRAM auth (about 2 RT). That is about 4–5 RT plus handshake CPU. Pool settings [V `packages/db/src/client.ts:180-190`]: `keepAlive: true`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`, `ssl: require`. After 30 s idle an instance closes its connections, so the next navigation after a short read pause pays the handshakes again, up to 6 in parallel.
  - Change: raise `idleTimeoutMillis` for the **web** pool to about 300 s, staying below Render PgBouncer's idle limits (not visible here; ask Render or read the dashboard). If Fluid compute is on (it is the default for new Vercel projects [I]; `vercel.json` does not say), call `attachDatabasePool(pool)` from `@vercel/functions` so idle clients are released cleanly before the instance suspends. Pool **width** and statement shapes are BACKEND.
  - Status: **partial**. keepAlive is done. The idle timeout is short. `attachDatabasePool` is not used: a grep of `apps/web` finds no `@vercel/functions`.
  - Impact (estimate): 4–5 RT × 1–5 ms, about 5–25 ms off the first navigation after every pause longer than 30 s. It also avoids repeated SCRAM work on PgBouncer.
  - Effort: S. Risk: more idle client slots held on PgBouncer (warm instances × 6 must stay under its client limit; DEPLOY.md step 5). Guard: keep `WEB_DB_POOL_MAX`. The existing `absorbConnectionError` handler (`client.ts:137`) already removes idle sockets the pooler drops.

- [ ] **G9. Session storage and cookie size: keep the small signed id with a database row**
  - Verified: the cookie is `ava_session=v2.<uuid>.<epoch>.<43-char HMAC>`, about 105 B on the wire. It is `HttpOnly`, `SameSite=Lax`, `Secure` and lasts 30 days (`lib/auth.ts:101-107`, `lib/session.ts`). The session lives in Postgres: one indexed join per request, memoised with React `cache()` (`auth.ts:21`). The `lastSeenAt` write is throttled to once an hour and is fire-and-forget (`auth.ts:34-36`). The OAuth cookie is scoped to `path=/auth/google` for 10 minutes, so it never rides on app requests.
  - Status: **done**. Do not move to a stateless JWT or a larger cookie: CLAUDE.md requires a database-row session so that revocation is immediate. Do not put per-account state (filters, tab, settings) in cookies either. That would force `Vary: Cookie` and add bytes to every request, including `_next/static` (the cookie has `path=/`). At 105 B, HPACK/QPACK reduces repeats to a few bytes after the first request [I].
  - Small follow-ups: remove the `christopher_session` fallback after **2026-10-23**, one TTL after rename commit `4fc3ba4` of 2026-09-23 (`session.ts:17-20` says the same). Memoising the HMAC `CryptoKey` is negligible (D-live #9).
  - Effort: S. Risk: none.

- [ ] **G10. Security headers: add a static set, cache-neutral**
  - Verified: `next.config.ts` has no `headers()`. Middleware sets only `cache-control` on `/share`. Only the logo route sets `content-security-policy` (sandbox) and `nosniff`.
  - Mechanism: a `headers()` rule for `/:path*` with `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on `/share/:path*`, whose URL is the credential), `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) and a minimal `Permissions-Policy`.
  - HSTS: `*.vercel.app` sits under `.app`, an HSTS-preloaded TLD, so there is never an http→https redirect round trip. If a custom domain outside `.app` is added, send `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` and submit it to the preload list. That removes the 301 round trip on typed URLs.
  - Caching interaction: static headers do not affect caching. Never add `Vary` with them. Avoid a **nonce** CSP: it forces a per-request render and makes otherwise static responses uncacheable. Use `'self'` plus hashes, or `strict-dynamic` without nonces.
  - Status: **not done**. Impact: performance about 0 (a few hundred bytes on the first response only, then header-compressed). The gain is security.
  - Effort: S. Risk: a full CSP can break Next's inline bootstrap. Guard: ship `Content-Security-Policy-Report-Only` first and add a smoke assertion that the headers are present.

- [ ] **G11. Global state lives in Postgres, not in instance memory**
  - Verified: cross-request state is all in the database: sessions, `tasks`, the rate limits (`lib/rate-limit.ts`, integration-tested) and settings. Settings reads are deduplicated per request only (PERFORMANCE-REVIEW "Implemented"; PR #81). The one cross-request, per-instance cache is `lib/scan-run-report.ts:16-18`: 30 s TTL, 1,000 entries, keyed by `runId|userId`, holding summaries of finished scan runs. It is bounded, account-scoped and short-lived, so it is acceptable. `lib/role-refusals.ts` is browser-tab state, not server state.
  - Status: **done** and correct for serverless, where instances are many and short-lived. Do not add a cross-request in-memory cache of settings or catalogue data. PERFORMANCE-REVIEW's last paragraph forbids it without reliable invalidation, and each instance would serve different data. If shared caching is ever needed, use Next `unstable_cache`/`revalidateTag` with a per-account key, or a managed KV store in fra1. Weigh one extra network hop against the DB round trip it saves (1–5 ms), which is rarely worth it here.
  - Effort: none. Risk: none.

Cross-references (owned elsewhere): payload bytes and layout round trips → BACKEND. Pool width → BACKEND. Font weights and prefetch → FRONTEND. PgBouncer client limits and Fluid or instance settings → INFRA. RTT, TTFB and Web Vitals collection → TESTING & MONITORING.
