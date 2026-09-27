# G2. Frontend and client-side optimisation

Scope: bundling, code splitting, lazy loading, images, fonts, critical path, hydration and main-thread cost, INP/LCP/CLS, prefetch, Service Worker, client polling, animation. Topics owned by other sections get one cross-reference line at most.

Build checked: `apps/web/.next`, BUILD_ID `QP7nsTpT1lY-55sxp2qLm`. I rebuilt it from HEAD `069cdef` (merge of PR #81) because the build on disk was older than HEAD. Next 15.5.25, React 19.2.8.

Method: the same as C and A. For each page I took the union of the chunks for `/layout`, `/(app)/layout`, `/(app)/loading`, `/(app)/error` and the page itself, excluding polyfills, and gzipped each file at level 9.

Labels: **V** = verified in code or build output in this pass. **I** = inferred. "est." = an estimate, not a measurement.

## Current state (measured, V)

| Route | First-load gz, now | A-after (`fbaa385`) | C baseline (`8c2ac58`) | Route-specific chunks (gz) |
|---|---|---|---|---|
| `/cv/[id]` | **134.7 KB** | 133.4 | 159.7 | page 19.5 + shared 3.6 |
| `/companies/[id]` | 128.2 | 126.2 | 124.0 | roles table `7848` 10.7 + `9888` 2.6 + page 3.4 |
| `/library` | 126.6 | 125.2 | 150.7 | page 11.4 + shared 3.6 |
| `/` (Roles) | **126.0** | 124.0 | 121.8 | roles table `7848` 10.7 + `9888` 2.6 + page 1.2 |
| `/applications` | 120.6 | 119.2 | 117.6 | page 6.5 + `9888` 2.6 |
| `/suggestions` | 118.2 | 116.5 | 114.8 | page 6.6 |
| `/settings` | 114.8 | 113.4 | 140.4 | page 3.2 |
| `/companies`, admin | 114.3–114.8 | ~113.4 | ~112 | < 1 |
| `/health`, `/account`, `/learning` | 111.7–113.2 | 110.4–111.9 | 109–110 | < 2 |
| auth pages | 106.4 | 106.4 | 103.8 | — |

- **Shared floor, about 108 KB gz on every (app) page:**
  - react-dom `45bf4544`: 54.3 KB
  - Next router runtime `3445`: 46.2 KB
  - `next/link` `3149`: 3.4 KB
  - `(app)/layout`: 4.0 KB
  - webpack runtime and error boundary: 3 KB
- **zod** (`9269`, 86.6 KB raw) is only an async chunk now. No client chunk contains cheerio, parse5, drizzle or `ZodError`.
- **Growth since A-after:** `/` and `/companies/[id]` went up by about 2 KB gz. The roles-table chunk went from 33.9 to 36.0 KB raw, because of the correctness-sweep commits (in-flight tracking, returning rows, refusal notices). Every (app) page went up by about 1.3 KB.
- **CSS:** 1 file, 41,191 B raw / 8,503 B gz. Unchanged.
- **Fonts:** 5 preloaded woff2 files, **36,968 B**. Silkscreen 400 is 3,528 B, Silkscreen 700 is 3,208 B, and IBM Plex Mono 400/500/600 are 10,060, 10,052 and 10,120 B.
- **Fallback fonts:** both generated fallbacks are `local("Arial")` with `size-adjust` (Silkscreen 149.62 %, Plex Mono 134.59 %).
- **Brand assets:** `favicon.ico` 538 B, `icon.svg` 680 B, `apple-icon.png` 705 B. The manifest icons are 705, 3,340 and 2,830 B, and `public/brand/*` are all under 4 KB. The mark on the page is inline SVG.

---

## Checklist

### F1. Roles table: stop re-rendering all 50 rows on every keystroke, `j`/`k` press and reason-box edit

- **Recommendation**
  - Extract the row body of `RolesTable` into a `React.memo` component, `RoleRow`, with stable props.
  - Move the reason-box text into local state inside a small `ReasonBox` child.
  - Wrap `SafeMarkdown` in `memo`.
- **Mechanism**
  - `const RoleRow = memo(function RoleRow(props) {...})`.
  - Pass it only primitives and stable callbacks. Handlers go through one `useRef`-backed dispatcher, for example `const act = useEvent(...)` or a `handlersRef.current` object, so identities do not change.
  - Pass `highlighted`, `selected`, `busy`, `expanded`, `detail` and `boxed` as per-row values. A keystroke then changes one row's props, and React bails out of the other 49.
  - `ReasonBox` holds `const [text, setText] = useState(prefill)` and reports it through `onSubmit(text)`. The parent's `reasonBox` keeps `{jobId, kind, pending, error}` only.
  - `export const SafeMarkdown = memo(SafeMarkdownImpl)`. When a row is expanded, its description is currently re-parsed by `parseBlocks` and `parseRuns` on every keystroke in that row's reason box.
- **Status: partial** (V)
  - Done: `rows` is memoised (`components/RolesTable.tsx:148`), and the scroll effect runs only when `highlightIndex` changes (`:495-504`). Together these removed the forced layout and the scroll jump on each keystroke.
  - Not done:
    - The row is rendered inline in `rows.map` (`:604`).
    - The textarea's `onChange` calls `setReasonBox` on the table (`:752`). `j` and `k` call `setHighlightIndex` on the table (`:465-470`). Both re-render every row, including 50 `CompanyFavicon`s, `FitBar`s (10 spans each) and badges.
    - `SafeMarkdown` has no memo (`components/SafeMarkdown.tsx`).
- **Impact** (est.; no browser profile was run, because the brief rules out starting servers)
  - About 50 × 40 fibers are reconciled per keystroke. That is roughly 2–5 ms on desktop and 10–25 ms on a mid-range Android phone, plus the markdown parse of an open description. The upper end reaches INP "needs improvement" once combined with input delay.
  - After the change: one row's subtree, well under 1 ms.
- **Effort:** M. It is a mechanical extraction, but the row reads about 15 closure variables.
- **Risk and guard**
  - A memoised row with a stale callback could act on the wrong row or state. Guard: route handlers through a ref that is updated every render, so the identity is stable and the target is always current.
  - Keep `RolesTable.test.tsx` green, and add a test that asserts one row's render count per keystroke with the React Profiler API (`<Profiler onRender>`).
  - Do not virtualise the table. It is 50 rows and server-paginated, and `j`/`k`, find-in-page and `scrollIntoView` all depend on real rows.

### F2. Company logos: store a 64 px raster at capture, not the site's original icon

- **Recommendation:** in the worker's logo capture, downscale raster logos to 64×64 and re-encode them as WebP before storing. Backfill the existing rows with a one-off task.
- **Mechanism**
  - `sharp(bytes).resize(64, 64, { fit: "contain", background: { r:0, g:0, b:0, alpha:0 } }).webp({ quality: 90, effort: 4 }).toBuffer()`.
  - Store the result with `content_type = image/webp`. The route and `sniffImageType` already recognise WebP (`packages/core/src/logo-capture.ts:59`).
  - Keep SVG as it is. It is already checked by `unsafeSvgReason` and is usually small.
  - For ICO, which libvips cannot decode, read the ICO directory and pass on the largest PNG-embedded entry of at least 32 px. Keep the original bytes when the best entry is BMP.
  - Bound memory on the 512 MB instance with `sharp.concurrency(1); sharp.cache(false)`.
  - The largest slot is 32 CSS px (`CompanyFavicon size={32}` on the company page). The table uses 14. 64 px covers 2× DPR at 32 and 4× at 16. AVIF is not worth its encode cost at 64 px.
- **Status: not done** (V)
  - `LOGO_MAX_BYTES = 512 KB` (`logo-capture.ts:18`), and bytes are stored as fetched.
  - Capture prefers `apple-touch-icon` (typically 180×180 PNG) and then multi-size `favicon.ico` (often with a 256 px entry) (`logo-capture.ts:130-143`).
  - The route serves the stored bytes unchanged (`app/api/companies/[id]/logo/route.ts`).
  - `sharp` 0.35.4 is only a transitive dependency of `next`. It is not a dependency of `apps/worker`.
  - Neither local fixture has any captured logos, so I could not measure a size distribution.
- **Impact** (est.)
  - A touch icon is typically 5–30 KB, and an ICO with a 256 px entry 15–100 KB. The 64 px WebP is about 1–3 KB.
  - A roles page references up to 50 distinct company icons. With `loading="lazy"`, about 15 load at first paint. That saves roughly 50–400 KB of image transfer per cold page and less image decode on the main thread.
  - No CLS effect, because width and height are already set.
- **Effort:** M. Worker code, ICO entry parsing, a backfill task and tests.
- **Risk and guard**
  - A resize failure must not lose the logo. Guard: on any sharp error, store the original bytes, which is today's behaviour, and log it.
  - Resize by the sniffed type, never by the declared type.
  - Keep `fetched_at` as the version key, so a re-encoded backfill busts the immutable URL.
- **Not applicable:** `next/image` for logos. The Vercel optimiser fetches the source URL without the viewer's cookie, and the logo route requires `routeUser()` (`route.ts:31`), so it would get a 401 (V). The optimiser would also bill per source image.

### F3. Fonts: stop preloading the unused Silkscreen 700, and use a monospace fallback for Plex

- **Recommendation**
  1. Remove `"700"` from `Silkscreen({ weight })`.
  2. For IBM Plex Mono, replace the Arial metric fallback with a real monospace stack.
  3. Leave Plex 500 in place unless the design owner merges it.
- **Mechanism**
  - `Silkscreen({ weight: ["400"], subsets: ["latin"], display: "swap", variable: "--font-pixel-family" })`.
  - `IBM_Plex_Mono({ ..., adjustFontFallback: false, fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"] })`.
  - A monospace fallback has uniform advance widths: Plex is 600/1000 em, Menlo 602 and Courier New 600. Line breaks and `tabular-nums` columns therefore match much more closely than proportional Arial scaled by `size-adjust` to an average width.
  - Keep `display: "swap"` and the default `preload: true`. Both families paint above the fold on every page.
- **Status: not done** (V)
  - `app/layout.tsx:9-21` still requests 400 and 700 for Silkscreen.
  - `ds-pixel` pins `font-weight: 400` (`globals.css:257-259`). No element in `components/` or `app/` combines `ds-pixel` with a weight utility. The one `<strong className="ds-pixel">` (`CvAssessmentPanel.tsx:126`) is also forced to 400 by the utility layer.
  - `kbd` sets no weight (`globals.css:244-255`), so a `<kbd>` inside bold text is the only way Silkscreen 700 could be requested. The browser would then synthesise bold instead.
  - The Plex fallback is `local("Arial")` with `size-adjust: 134.59%` (from the build CSS).
  - Plex 500 is used as `font-medium` 23 times in 14 files.
- **Impact**
  - Silkscreen: −3,208 B preload and one fewer request on every hard load, including `/login` (measured).
  - Monospace fallback: lower font-swap CLS on a first visit or cold cache (est. CLS from ≤ 0.02 to about 0). Repeat visits hit the immutable font cache, so nothing changes there.
  - Merging Plex 500 into 400 or 600 would save another 10,052 B, but that is a design-system decision (DESIGN-SYSTEM.md, Typography).
- **Effort:** S.
- **Risk and guard**
  - Synthesised bold on a `<kbd>` inside bold text. Guard: grep for `<kbd>` inside `font-semibold` containers, and check `/`, `/suggestions` and the CV tabs visually.
  - The monospace fallback is only visible for the swap period.

### F4. Sidebar prefetch: keep `prefetch={false}`, and revisit only on field data

- **Recommendation:** do not turn on prefetch now. If navigation data later justifies it, use hover-intent `router.prefetch` on the five sidebar `NavLink`s only, with a dwell time, and never on table rows.
- **Mechanism** (if adopted)
  - In `NavLink`, add `onPointerEnter` and `onFocus` handlers that start `setTimeout(() => router.prefetch(href, { kind: PrefetchKind.FULL }), 80)`, cleared on `onPointerLeave` and `onBlur`.
  - Pair it with `experimental.staleTimes: { static: 30 }` in `next.config.ts`. 30 s is the minimum. The default of 300 s would let a hovered Roles page be shown up to 5 minutes stale.
  - The default `kind: AUTO` prefetches a force-dynamic route only down to its nearest `loading.tsx`. Here that is `(app)/loading.tsx`, which the client already holds, so AUTO gains almost nothing. Only FULL hides the server render.
- **Status: deliberate `prefetch={false}` everywhere** (V)
  - All `<Link>`s use it: `NavLink.tsx:31`, the layout, and table rows (commit `c836da9`, WP7: 50 table rows prefetched the layout 100 times).
  - `NavigationMetrics` already beacons each client navigation's duration to `/api/performance` (`components/NavigationMetrics.tsx`), so the decision can be made on real numbers.
- **Impact** (est.)
  - It would hide the hover-to-click interval, typically 100–250 ms, of one RSC round trip per sidebar navigation. Today `/` costs 4.4 effective sequential DB round trips plus about 55 ms of render (A-after tables 2 and 3). On Vercel fra1 that is about 150–300 ms.
  - The cost is one full server render per hover that does not end in a click, plus a 30 s staleness window. That window would also cover a page just changed in another tab.
  - Honest verdict: the gain is real but small, and it adds back exactly the class of server load WP7 removed. Adopt only if the `/api/performance` p75 for sidebar navigation exceeds about 400 ms.
- **Effort:** S.
- **Risk and guard**
  - Stale counts after a write. Guard: keep `staleTimes.static` at 30 s. Server actions already revalidate and purge the client cache, and `router.refresh()` purges it too.
  - Measure server invocations per active user before and after.
- Cross-reference: whether the RSC response is cacheable at the edge belongs to GLOBAL.

### F5. Service Worker: do not add one

- **Recommendation:** no Service Worker, and no shell precache.
- **Mechanism considered:** Workbox `precacheAndRoute` for `/_next/static/*`, plus a navigation route for the shell.
- **Status: not applicable** (V: there is no `sw.js` or registration in `apps/web`; the manifest is `display: "standalone"` with no SW)
  - Every JS, CSS and font asset is content-hashed under `/_next/static`. Vercel serves those with `Cache-Control: public, max-age=31536000, immutable`, so repeat visits already come from the HTTP cache with zero requests.
  - HTML and RSC are per-account and force-dynamic. Authentication is a database row (CLAUDE.md), so caching a shell or RSC response in a Service Worker would render pages for a revoked session and would show stale per-account counts.
  - Offline use is not a goal.
- **Impact:** at most, a cold HTTP cache after eviction would be rescued (est. < 1 % of loads). Meanwhile a Service Worker adds its own startup cost to every navigation request (est. 5–50 ms on mobile when the worker is not running).
- **Effort:** — | **Risk:** stale deploys and stale authentication if added. Guard: do not add it.

### F6. `next.config.ts` options: what to set and what to leave

- **Status of each option** (V: `apps/web/next.config.ts`; defaults from `next/dist/server/config-shared.d.ts`)

| Option | Recommendation | Exact setting | Why | Risk |
|---|---|---|---|---|
| `experimental.optimizePackageImports` | Leave unset | — | No large barrel reaches the client. The only third-party client library is zod, which is async now. `@ava/core`'s root barrel is imported by one client file, `CvGapQuiz.tsx`, which is itself a lazy chunk. The others use subpath exports (`@ava/core/cv-theme-values`, `/role-workflow`, `/cv-helpers`). | None |
| `experimental.reactCompiler` | Do not enable yet. Do F1 by hand | (would be `reactCompiler: true` plus the `babel-plugin-react-compiler` devDependency) | The compiler skips any component that reads or writes `ref.current` during render. `RolesTable` (`reasonBoxRef.current = reasonBox`, `rowsRef.current = rows`, `returningRef.current = …`), `SuggestionDeck` (`dxRef.current = dx`) and `CvBuildLive` all do, so the hot components would not be optimised. It also puts Babel into the SWC build (slower builds). Revisit after F1 with `compilationMode: "annotation"` on selected leaves. | Subtle behaviour change in code that breaks the Rules of React. The plugin is not installed (V) |
| `experimental.inlineCss` | Leave `false` | — | CSS is one 8.5 KB gz immutable file. Inlining adds 8.5 KB to every hard-load HTML (`/` is 22 KB gz today) and gives up the cross-visit cache, which is a poor trade for daily signed-in users who mostly come back. It would save 1 round trip only on a cold first visit. | More HTML bytes per load |
| `images` | Leave unset | — | `next/image` is not used, and cannot serve the authenticated logo route (F2). Brand images are under 4 KB. | — |
| `experimental.staleTimes` | Set only with F4 | `staleTimes: { static: 30 }` | Keeps any future FULL prefetch fresh. Today no FULL prefetch exists, so it has no effect. | Minimal |
| `productionBrowserSourceMaps` | Keep the default (`false`) | — | Maps would be public and add build output; there is no runtime cost. | — |

- **Effort:** S (config only).

### F7. CV page: load the build narrative only when the log is opened on a finished CV

- **Recommendation:** on a ready CV whose build is not live, render the build log's `CvBuildNarrative` and the `narrateBuild` call from a lazy chunk that loads when the "Show build log" disclosure opens. Keep a live build (`mode="build"`, or `reading.live`) exactly as it is.
- **Mechanism**
  - Use `next/dynamic` in a client module with no `loading` option, following the rationale in `components/CvLazyWidgets.tsx`: no Suspense boundary, so nothing flashes.
  - Trigger it from `CvDisclosure`'s `open` state, for example with a `lazyChildren` render prop that `import()`s `lib/cv-build-narrative` on first open.
  - The server keeps using `cvBuildTotalsLine` for its own line.
- **Status: not done** (V)
  - The `/cv/[id]` page chunk is 62.4 KB raw / 19.5 KB gz. It includes `CvBuildLive`, `lib/cv-build-narrative.ts` (54 KB of source), `CvDraftEditor` and `CvAppearance`.
  - `CvDisclosure` renders its children while `hidden` (`components/CvDisclosure.tsx:24`), so the narrative is computed and rendered even while the log is closed.
- **Impact** (est.): 5–8 KB gz off the first load of `/cv/[id]` (134.7 KB), plus less hydration work on ready CVs.
- **Effort:** M.
- **Risk and guard**
  - The CV progress-stream semantics must not change. Guard: touch only the `mode="log"` path with `!reading.live`, and keep `CvBuildLive.test.tsx` green.
  - A chunk that fails to load must show an error sentence. Follow the pattern of `8a5b781`, "Say so when the CV preview's check cannot be loaded".

### F8. CV build clock: stop recomputing the narrative every second when nobody can see it

- **Recommendation:** gate `CvBuildLive`'s 1 s clock (`setNow`) on the tab being visible, and in log mode also on the disclosure being open or a `current` line being shown.
- **Mechanism**
  - Inside `tick`, return early when `document.visibilityState !== "visible"`, and call `tick()` on `visibilitychange`.
  - In log mode, compute `items = narrateBuild(...)` only when the log is open, or memoise it on `[steps, Math.floor(now / 15_000)]` while it is closed.
- **Status: not done** (V)
  - `components/CvBuildLive.tsx:84-91` ticks every 1 s while `live`.
  - `:203` runs `narrateBuild(steps, at, context)` on every tick and re-renders the whole narrative list. In log mode that list sits inside a closed, `hidden` disclosure.
  - Browsers throttle hidden-tab intervals to at most 1 per second, and Chrome's intensive throttling reduces that to once a minute after 5 minutes. The work is capped but not zero.
- **Impact** (est.): about 1–3 ms of main-thread work per second for the length of a build and its improvement pass (minutes). This matters for battery and INP on the CV page, not for the server.
- **Effort:** S.
- **Risk and guard:** elapsed figures must jump to the correct value when the tab returns. Guard: tick immediately on `visibilitychange`. The skew-corrected clock (`skewRef`) already handles this.

### F9. Client polling: record what is done; one small gap

- **Status of each poller** (V)

| Poller | Cadence and back-off | Hidden tab | Stops | File |
|---|---|---|---|---|
| `AutoRefresh` | 10 s, ×1.5 per unchanged reading, capped at 60 s. A change resets it to 10 s. The first failure costs no wait. | Parks, and reads again on `visibilitychange` | When the work is finished: 2 soft refreshes, then a reload on the CV page only | `components/AutoRefresh.tsx`, `lib/polling.ts` |
| `ScanStatusBanner` | 30 s while a run is live, backing off to 60 s. Between runs it sleeps until the next run's hour plus 1–60 s of random jitter. Re-reads on return if the last reading is more than 10 min old. The minute tick of its clock is also gated on visibility. | Parks | After 5 failures, leaving a note | `components/ScanStatusBanner.tsx:32-106` |
| `CvBuildLive` (progress) | 10 s, backing off to 30 s. Brought forward when rows arrive. | Parks | When the build is finished | `components/CvBuildLive.tsx:94-190` |
| `LibraryImportPoller` / `LibraryEvidencePoller` | First at `FIRST_MS`, ×1.5 up to `LONGEST_MS`, with a hard ceiling `until` | Skips the fetch but keeps its timer running (there is no park) | At the ceiling, or when no import is pending | `components/LibraryImportPoller.tsx:30-70` |
| `Elapsed` | 1 s, or 15 s in relative mode. Bounded to the CV progress view and the setup timeline. | Throttled by the browser | On unmount | `components/Elapsed.tsx:22` |

- **Recommendation:** no change in cadence or back-off.
  - The one gap is in the two Library pollers. While the tab is hidden their `until` ceiling keeps counting down, so a user who comes back after the ceiling has passed gets no further refresh.
  - That is a correctness concern, not a performance one. Park them the way `AutoRefresh` does (flag plus `visibilitychange`) if they are touched for another reason.
- **Impact:** none on performance (the fetches are already skipped while hidden).
- **Effort:** S.
- Cross-reference: the server cost of `/api/work-status` and `/api/scan-status` belongs to BACKEND.

### F10. Animation cost: keep as is, and do not add `will-change`

- **Status: done** (V)
  - **Loading mark**
    - `@keyframes ds-mark-turn` animates `transform: scaleX()` only, with `step-end` timing and eight steps on a 200 ms beat, over a 2.4 s cycle (`globals.css:172-189, 327-329`).
    - Each letter carries `ds-mark-letter ds-animate` (`components/brand/Mark.tsx:54-56`), and `@media (prefers-reduced-motion: reduce) { .ds-animate, [class*="animate-"] { animation: none !important } }` stops it (`globals.css:331-336`). Reduced motion is honoured.
  - **Deck fly-off**
    - It animates `transform` only (`translateX` plus `rotate`) with a 240 ms stepped transition. The Follow and Dismiss stamps change only `opacity`.
    - `matchMedia("(prefers-reduced-motion: reduce)")` switches off the transition and the fly-off picture (`SuggestionDeck.tsx:63-69, 104, 213`).
- **Recommendation:** no change.
  - Chromium does not composite transforms on SVG child elements, so the mark repaints its 24–48 px box at each step, about 5 paints per second per turning mark (I). That is negligible. `will-change: transform` would not promote an SVG `<path>` and would only cost memory on the deck.
  - Optional micro-change: a drag calls `setDx` on every `pointermove` (`SuggestionDeck.tsx:176`), which re-renders the deck. The card body is a stable server node, so each re-render is cheap (est. < 1 ms). Writing `style.transform` through a ref inside `requestAnimationFrame` would remove even that, but it is not worth the extra complexity.
- **Effort:** — | **Risk:** none.

### F11. Editors' `onChange` paths: fine at current sizes, with one cheap fix

- **Recommendation**
  - In `CvDraftEditor`, memoise the baseline fingerprint: `const baseline = useMemo(() => JSON.stringify({ ...content, theme: baseTheme }), [content, baseTheme])`. Today every keystroke in the summary or a section stringifies the whole CV twice.
  - Leave `CvLibraryEditor` as it is.
- **Mechanism:** `useMemo` for the baseline. For future growth, `useDeferredValue(value)` could feed `readiness`, `jobs` and `archived` in `CvLibraryEditor` so the input stays urgent.
- **Status: partial** (V)
  - `CvDraftEditor.tsx:125-128` computes both stringifies on every render.
  - `CvLibraryEditor.tsx:69-87` memoises `JSON.stringify(value)`, `readiness`, `jobs` and `archived` on `value`, but `value` changes on every keystroke, so each keystroke still runs all four.
  - The bench fixture's libraries are 4.3 KB (`cv_libraries.content`, 100 rows, max 4,309 characters, measured).
  - The library is no longer re-opened on the client (`CvLibraryEditor.tsx:32,43`; done in PR #81).
- **Impact** (est.)
  - Under 1 ms per keystroke at 5–20 KB of content.
  - `useDeferredValue` becomes worthwhile only above about 100 KB of library JSON (roughly 5+ ms per keystroke on mobile).
- **Effort:** S.
- **Risk:** none for the `useMemo`. With `useDeferredValue`, the dirty or readiness indicator could lag the input by a frame, which is acceptable.

### F12. CLS and LCP: state, and the remaining lever

- **CLS: done, except the first-visit font swap (F3)** (V)
  - `CompanyFavicon` sets `width` and `height`, and its placeholder `<span>` has the same box (`CompanyFavicon.tsx:25-37`).
  - The layout's Suspense fallbacks take the same space as the content that replaces them: the scan-status line is one line of text in a fixed strip, and `SettingsNavLink`'s fallback is the same `NavLink` without the count (`app/(app)/layout.tsx:45-47, 69-72`).
  - The CV widgets have no Suspense boundaries of their own (`CvLazyWidgets.tsx`), so nothing flashes.
  - `(app)/loading.tsx` is replaced as a whole by the page under a transition, which is a replacement rather than a shift.
  - No page loads images without dimensions.
- **LCP: server-bound** (I)
  - On a hard load the HTML streams the shell and the `loading.tsx` mark first, then the page. The LCP element is the page's content (the `PageHeader` h1, or the first table or card block).
  - No render-blocking third-party request exists, CSS is 8.5 KB, and both font families are preloaded and self-hosted.
  - Chrome counts text painted in the fallback font as an LCP candidate, so `display: swap` does not delay LCP.
  - What delays LCP is TTFB plus the render of the page segment (A-after: `/` p50 64 ms locally, 4.4 effective DB round trips at pool 6).
  - Cross-reference: the TTFB and RSC render budget belongs to BACKEND and GLOBAL.
- **Recommendation:** no frontend change beyond F3 and F2. Watch the roles-table chunk, which grew by 2 KB gz since A-after. A per-route JS budget belongs in TESTING & MONITORING, for example `/` ≤ 130 KB gz and `/cv/[id]` ≤ 140 KB gz.

### F13. Client/server boundary: the only items still open

- Of C's 39-file inventory, these are still open (V):

| Component | Open item | Recommendation | Impact | Effort |
|---|---|---|---|---|
| `CvGapQuiz` (L) | Receives the whole `draft.librarySnapshot` (`app/(app)/cv/[id]/page.tsx:284-286`) but needs only entries and employment titles | Pre-shape on the server into `{ entries: {id, heading}[], employment: {id, company, jobTitle}[] }` | Smaller RSC and HTML while a quiz is open. Rare page state (est. a few KB) | S |
| `CvDisclosure` (M) | A client component for an open/close toggle | Leave it. A native `<details>` would lose the `aria-expanded` button styling, and F7 needs its `open` state anyway | — | — |
| `NavLink` ×6 (H) | `usePathname` for the active state | Leave it. The client highlight on navigation is worth 1 KB | — | — |

- **Done since C** (V):
  - SuggestionDeck sends 8 cards, not 50 (`app/(app)/suggestions/page.tsx:111,122`).
  - `CvGapQuiz`, `CvShareCreateForm` and `CvEvaluationTable` are dynamic (`components/CvLazyWidgets.tsx`).
  - `CvAppearance` is zod-free through `@ava/core/cv-theme-values`.
  - `CvDraftEditor` loads `CvContentSchema` lazily (`:142-144`).
  - The library merge is imported lazily (`CvLibraryEditor.tsx:202`).
  - The library re-parse is gone.

---

## Already done (verified in this pass; do not re-recommend)

| Item | Where verified |
|---|---|
| zod out of every first load (/settings −29 KB, /library −28, /cv/[id] −29 KB gz) | `.next/app-build-manifest.json`: `9269` is async only |
| `CompanyFavicon` `loading="lazy"` and `decoding="async"` | `components/CompanyFavicon.tsx:33-34` |
| Redundant `router.refresh()` after revalidating actions removed; one request per decision | A-after §5; RolesTable has no `router.refresh` (grep) |
| Optimistic row removal, with a revert on refusal | `components/RolesTable.tsx:140-156` |
| `rows` memoised; scroll-into-view only on `j`/`k` | `components/RolesTable.tsx:148, 495-504` |
| Deck payload of 8 cards; stepped, reduced-motion-aware fly-off | `suggestions/page.tsx:111`; `SuggestionDeck.tsx:63-69, 213, 245-250` |
| CV occasional widgets split without Suspense flash | `components/CvLazyWidgets.tsx` |
| Pollers back off, park when hidden, and stop | F9 table |
| Fonts self-hosted, latin subset, `swap`, metric fallbacks, no Google requests | `app/layout.tsx`; build CSS |
| Brand mark inline SVG, one path per letter; favicons and icons under 4 KB | `components/brand/*`, `public/brand/*` |
| Logo route immutable for a day on versioned URLs, ETag and 304 | `app/api/companies/[id]/logo/route.ts:44-50` |
| No server-only code or large library in client chunks | chunk grep: 0 hits for cheerio, parse5, drizzle and `ZodError` outside `9269` |
