# C: Client-side audit of apps/web (code and build output)

Build audited: `apps/web/.next`, BUILD_ID `24BeSSx6mMt7CLIi5OvOL`, from HEAD `8c2ac58` (merge of PR #80). Next 15.5.25, React 19.
No server was started. All byte figures come from the build output. "gz" means `gzip -9` of each file. Vercel serves brotli, which is roughly 10–15% smaller.

## Ranked findings

| # | Finding | Where | M/I | Estimated gain | Risk | Effort |
|---|---|---|---|---|---|---|
| 1 | Actions that already revalidate are followed by `router.refresh()`, so each decision renders the whole tree twice | `components/RolesTable.tsx:176,268,288`; `SuggestionsStrip.tsx:45,60`; `SuggestionDeck.tsx:94`; `FollowCompanyButton.tsx:20`; `ApplicationsTable.tsx:236`; `RefreshCompanyButton.tsx:15`; `LibraryImportForm.tsx:68` | Mechanism verified in Next source. Cost inferred | About 50% of the server work and one full RSC download per decision on Roles, the most frequent write in the product | Low–med | S |
| 2 | zod (84.6 KB raw) and the CV schemas are shipped to three routes. On /settings they are there only for a theme picker | `components/CvAppearance.tsx:3-11`, `CvDraftEditor.tsx:5-11,136`, `lib/cv-library-merge.ts:15,131`, `lib/cv-library-rows.ts:19,48`; source `packages/core/src/cv-theme.ts:1`, `cv.ts:5` | Measured | /settings -28 to -30 KB gz (140.4 to about 111). /library and /cv/[id] -20 to -30 KB gz if validation is loaded lazily | Low (settings), med (editors) | S / M |
| 3 | RolesTable recomputes `rows` on every render, so the keyboard listener and `scrollIntoView` effects run on every state change, including every keystroke in a reason box. With the highlight stuck at row 0 for mouse users, this probably also scrolls the page back to row 0 | `components/RolesTable.tsx:131,296-351` | Inferred. Needs a browser check | Removes a forced layout per keystroke and a 50-row re-render. Possibly fixes a visible scroll jump | Low | S |
| 4 | The Discover deck serialises 50 server-rendered cards but shows 2, and it is re-sent twice after every swipe (see #1) | `app/(app)/suggestions/page.tsx:114,164`; `components/SuggestionDeck.tsx:41-43,174`; `lib/queries/suggestions.ts:35` | Inferred | About 90% of that page's RSC payload per swipe | Low | S |
| 5 | `revalidatePath("/", "layout")` in two frequent Applications actions. `decide` already dropped this for the reason given in its own comment | `app/actions/applications.ts:234,389` | Inferred (owner's precedent at `decisions.ts:100-110`) | Keeps the client router cache across stage changes, so fewer full-tree navigations after them | Low–med | S |
| 6 | Company icons: 50 eager `<img>` per roles page with a sequential chain of failing third-party requests, and no `loading="lazy"` or `decoding="async"` | `components/CompanyFavicon.tsx:24-33` | Inferred | Defers about 35 of 50 icon requests below the fold on first paint | None | XS |
| 7 | Five font files preloaded on every page (37.1 KB). Silkscreen 700 looks unused, because `ds-pixel` pins weight 400 | `app/layout.tsx:9-21`; `app/globals.css:257-259`; `.next/static/media/*.p.woff2` | Measured | -3.2 KB preload and 2 fewer @font-face rules. Dropping Plex 500 would save a further 10 KB, but that is a design call | Low | XS |
| 8 | CV page: rarely used widgets are bundled into the main chunk (`CvGapQuiz`, `CvShareCreateForm`, the evaluation table) | `app/(app)/cv/[id]/page.tsx:280,340`; page chunk 68.8 KB raw | Measured chunk, split inferred | 5–10 KB gz on /cv/[id] | Low | S |
| 9 | Library editor parses the stored library with zod three times on the client after the server already did | `components/CvLibraryEditor.tsx:41,50,118`; `app/(app)/library/page.tsx:43` | Inferred | Some ms of hydration CPU for a large library. Pairs with #2 | Med | M |
| — | Later: hover-intent prefetch on the 5 sidebar links only | `app/(app)/layout.tsx:69-78`, `components/NavLink.tsx:31` | Inferred | Hides one RTT per sidebar navigation | Med (the reason prefetch was removed) | S |

## MEASURED

### Method

I parsed `.next/app-build-manifest.json` with Python. For each app page I took the union of the chunks for `/layout`, `/(app)/layout`, `/(app)/loading`, `/(app)/error` and the page entry, which is what a hard load of that page downloads. Then I summed the raw and gzip-9 byte counts of those files. Polyfills (`nomodule`) are excluded because modern browsers never fetch them. I grepped the chunk contents for package markers.

### First-load JS per page

| Page | raw | gz |
|---|---|---|
| /cv/[id] | 535.8 KB | **159.7 KB** |
| /library | 508.1 KB | **150.7 KB** |
| /settings | 472.3 KB | **140.4 KB** |
| /companies/[id] | 410.2 KB | 124.0 KB |
| / (Roles) | 404.8 KB | 121.8 KB |
| /applications | 388.9 KB | 117.6 KB |
| /suggestions | 382.5 KB | 114.8 KB |
| /companies | 371.4 KB | 112.0 KB |
| /admin, /admin/catalogue | 371 KB | 111.5 KB |
| /learning | 369.1 KB | 110.4 KB |
| /account, /admin/settings | 366.1 KB | 109.7 KB |
| /health, /admin/health, /cv/library | 364.5 KB | 109.0 KB |
| /login (and the other auth pages) | 351.6 KB | 103.8 KB |
| /share/[token] | 343.3 KB | 100.5 KB |

### Chunks by size

| Chunk | raw / gz | What it is | Loaded by |
|---|---|---|---|
| `45bf4544-…js` | 169.1 / 53.0 KB | react-dom | all pages |
| `3445-…js` | 169.6 / 45.1 KB | Next app-router runtime | all pages |
| `9269-…js` | **84.6 / 23.2 KB** | **zod v4** (single module; contains `$ZodType`, `ZodError`) | /cv/[id], /library, /settings |
| `app/(app)/cv/[id]/page` | 68.8 / 21.2 KB | CvDraftEditor, CvBuildLive, `lib/cv-build-narrative.ts` (54 KB source), CvWorkspace, CvEvaluationTable, CvGapQuiz, CvShareCreateForm | /cv/[id] |
| `app/(app)/library/page` | 41.1 / 12.2 KB | CvLibraryEditor, EmploymentHistoryTable, LibraryRowTypeMenu, EvidenceScore, LibraryImportForm | /library |
| `482-…js` | 31.9 / 9.4 KB | RolesTable, Badge, table, SafeMarkdown, role-workflow | /, /companies/[id] |
| `3906-…js` | 18.1 / 6.5 KB | `@ava/core/cv` schemas and helpers ("Use a six-digit hex colour.", "Employment IDs must be unique.") | /cv/[id], /library, /settings |
| `app/(app)/layout` | 10.0 / 3.9 KB | ScanStatusBanner, NavLink, WorkspaceNav, NavigationMetrics, `lib/polling` | all (app) pages |
| `3149-…js` | 8.3 / 3.3 KB | next/link | nearly all |
| everything else | < 20 KB each | page code | |

The floor is about 100 KB gz (react-dom plus the Next runtime) on every route. That is normal for Next 15 and cannot be reduced without leaving the framework.

**Leaks: none.** I grepped every client chunk for drizzle, pg-protocol, pdfkit, anthropic, `@ava/db`, playwright, `node:crypto`, `createHmac`, scrypt, fontkit, `DATABASE_URL` and `SESSION_SECRET`, and for any `process.env.*`: 0 hits for each. No date library, markdown library or lodash is present either. The only third-party library in client code is zod.

**/settings is +30.7 KB gz over the (app) baseline, and nearly all of it is zod plus the cv schemas** (23.2 + 6.5 KB). The only client component on that page that needs them is `CvAppearance`, which imports `resolveCvTheme` (a `CvThemeSchema.safeParse` at `packages/core/src/cv-theme.ts:43`) and theme constants from `@ava/core/cv`. That import pulls in all of `cv.ts` and zod.

### CSS and fonts

- CSS: one file, `static/css/232b1ddffd6cbdd3.css`, 41,191 B raw / 8,503 B gz, loaded once from the root layout. It is purged and has no `@import` of remote resources. This is fine.
- Fonts: `next/font/google` with `display: swap` and the latin subset, self-hosted, with metric-adjusted fallbacks generated. There are no `<link>` tags to Google. 19 woff2 files are emitted, but they are split by unicode-range, so a Latin page only fetches the `.p.` files.
- 5 files are preloaded on every page, including /login: `98e207f0` 10,060 B, `d3ebbfd6` 10,052 B, `db96af6b` 10,120 B (Plex 400/500/600), `cd21efac` 3,528 B and `966913ba` 3,208 B (Silkscreen 400/700). That is **36,968 B in total**.
- Silkscreen is only used through `@utility ds-pixel` (weight pinned to 400, `globals.css:257-259`) and `kbd` (normal weight). I found no `ds-pixel` element combined with `font-semibold`. Silkscreen 700 is therefore probably never painted, but it is still preloaded.
- Plex weight usage: 500 appears 23 times as `font-medium`, 600 appears 56 times as `font-semibold`.

### Icons and manifest

`app/favicon.ico` 538 B, `icon.svg` 680 B, `apple-icon.png` 705 B. Manifest icons are 705 / 3,340 / 2,830 B. All are tiny.

The brand mark is inline SVG from `components/brand/Mark.tsx`: one wordmark in the sidebar, plus a Monogram in the status strip and in pending states. Its path data (`mark-cells.ts`, 6 KB source) is in the layout's server HTML. Where a client component imports the Monogram, it adds under 2 KB gz to that chunk. Nothing needs to change here.

## INFERRED (from code), with details

### 1. Redundant `router.refresh()` after revalidating actions

**What happens now.** `decide`, `decideRoles` and `archiveRoles` call `revalidateDecided()` (`app/actions/decisions.ts:105-110,130,193,293`), and the comment above it says the current page "is re-rendered in the action's own response". That is true: Next 15.5.25 sets `store.pathWasRevalidated = true` on any `revalidatePath` call (`next/dist/server/web/spec-extension/revalidate.js:156`, with `// TODO: only revalidate if the path matches`). The action handler then renders the current page's full RSC tree into the action response (`action-handler.js:773,857`, `skipFlight: !workStore.pathWasRevalidated`). RolesTable then calls `router.refresh()` as well (lines 268, 288, 176), which issues a second full-tree request: the layout's `getCurrentUser`, scan status and health count, plus RoleWorkspace's counts, page, company options, stage counts and events.

**Why it costs.** Every shortlist, dismiss, undo or group action on the busiest page costs two server renders and two RSC downloads of a 50-row table. Commit `812256f` already removed exactly this pattern for the archive-row button ("the archive row no longer refreshes the router on top of the action's own re-render") but left it in decide, undo and group.

**The change.** Delete the `router.refresh()` calls on success paths where the action always calls `revalidatePath`:
- RolesTable 176, 268, 288
- SuggestionsStrip 45 and 60 (both actions revalidate `/learning`, and accept also revalidates `/`)
- SuggestionDeck 94 (`acceptSuggestion` and `rejectSuggestion` both revalidate)
- FollowCompanyButton 20
- ApplicationsTable 236 (`manageRoleCv` revalidates, and the row is also patched)
- RefreshCompanyButton 15 (`refreshCompany` revalidates or redirects)
- LibraryImportForm 68 (the library-import actions revalidate `/library`; check each success path first)

Keep a refresh only where a success path returns without revalidating.

**How to verify.** In DevTools Network, a single decision should produce one POST (the action, carrying the RSC payload) and no following `?_rsc=` GET. Tab counts should still update. The existing `decisions.integration.test.ts` should stay green, and a Playwright check that the counts change after `a` or `s` confirms it.

### 2. zod on the client: split the zod-free parts of `@ava/core/cv`

**What happens now.** zod v4's classic `import { z } from "zod"` is not tree-shakeable, and schema definitions at module top level are side effects, so any value import from `@ava/core/cv` drags in all 84.6 KB raw of zod plus `cv.ts`.

**/settings: cheap and safe.**
- Move `CV_FONTS`, `CV_THEMES`, `DEFAULT_CV_THEME`, `cvForeground` and `cvMaxPages` into a zod-free module, for example `packages/core/src/cv-theme-values.ts`, re-exported by `cv-theme.ts` so no server caller changes. `CV_PAGE_CHOICES` already lives in the zod-free `cv-format.ts`.
- Have `CvAppearance` import only from that module plus `import type`.
- Resolve the theme on the server: the settings page already calls `getDefaultCvAppearance()`, and the CV page can pass `resolveCvTheme(content.theme)` down.
- Gain: /settings goes from 140.4 to about 111 KB gz, and the browser has roughly 100 KB less JS to parse on a mid-range phone.

**/cv/[id] and /library: moderate.**
- `CvDraftEditor.updatePreview` (line 136) validates with `CvContentSchema` only when the button is pressed. Replace it with `const { CvContentSchema } = await import("@ava/core/cv")` inside the handler, or rely on `/api/cv/preview`, which validates anyway, and show its 400 text.
- Library: `openStoredLibrary` (`lib/cv-library-rows.ts:48`) and `mergeCvLibrary` (`lib/cv-library-merge.ts:131`) parse on the client. The server already passes an opened library (`library/page.tsx:43`), so the client could skip the re-open, and the merge-time `safeParse` can load lazily.
- Together this takes 23–30 KB gz off both heavy pages.

**How to verify.** Rebuild and rerun the manifest script. `9269-*.js` should disappear from `/(app)/settings/page`. The typecheck and the CV and library tests should pass.

### 3. RolesTable: unstable `rows` retriggers effects on every render

**What happens now.** `const rows = inputRows.filter(...)` (line 131) creates a new array on each render. The keyboard effect (deps `[keyboard, rows, highlightIndex]`, line 351) removes and re-adds the window listener on every render. The scroll effect (deps `[highlightIndex, rows]`, lines 346-351) calls `scrollIntoView({block:"nearest"})` on the highlighted row on every render.

`highlightIndex` starts at 0 and only `j`/`k` change it (lines 191, 316, 320). So for a mouse user who scrolls to row 30, clicking to expand it or typing its reason (every keystroke runs `setReasonBox`, line 598) should scroll the page back to row 0. Every keystroke in either reason box also re-renders all 50 row subtrees, which have no memoised row component.

**The change.**
- `const rows = useMemo(() => inputRows.filter(r => !removedIds.has(r.id)), [inputRows, removedIds])`.
- Run the scroll effect only when `highlightIndex` changes, for example by tracking the previous index in a ref.
- Optionally extract the row into a `memo`'d `RoleRow` so a keystroke re-renders only the boxed row.

**How to verify.** Scroll down, expand row 30, type in the reason box: the page should not move. The React Profiler should show no commits for the other rows per keystroke.

### 4. Discover deck: send a handful of cards, not 50

**What happens now.** `listPendingSuggestions(user.id, 1)` returns up to 50 rows (`queries/suggestions.ts:35`). Each becomes a server-rendered `<SuggestionCardContent>` element serialised into the RSC payload. `SuggestionDeck` renders only `visible[0]` and `visible[1]`. After each swipe the action's re-render sends all 50 again, and `router.refresh()` sends them a third time.

**The change.** Fetch 5 cards for the deck, and pass the true total (`reviewCount`, already computed at `page.tsx:111`) for the "N to review" line, which currently uses `visible.length` (`SuggestionDeck.tsx:174`). Remove the refresh (#1). The action's own re-render refills the deck.

**How to verify.** The response size of the suggestions `?_rsc=` request should drop by roughly 10×. Swiping through more than 5 cards should keep working.

### 5. Layout-wide revalidation in Applications actions

**What happens now.** `setRoleStage` (`applications.ts:234`) and `manageRoleCv` (`:389`) call `revalidatePath("/", "layout")`. `decisions.ts:100-104` explains why the equivalent was removed from `decide`: "invalidating it made every later navigation render in full". Nothing in the (app) layout reads stage or CV state.

**The change.** Replace it with `revalidatePath("/")`, `revalidatePath("/companies/[id]", "page")` and the existing `/applications`. `account.ts:75` (`updateProfile`) is right to keep the layout, because the sidebar shows the name.

**How to verify.** After a stage change, navigating to Companies should not re-request the layout segment (check `Next-Router-State-Tree` or the server logs). The existing applications integration tests should pass.

### 6. CompanyFavicon

**What happens now.** A plain `<img>` with width and height set (good: no layout shift) at `CompanyFavicon.tsx:24`. It is eager, with 50 per roles page. For uncaptured companies the chain `faviconUrl`, then `https://host/favicon.ico`, then DuckDuckGo runs sequentially on error, so each failed step is a serial third-party round trip. The captured-logo route sets `public, max-age=86400, immutable` for versioned URLs (`api/companies/[id]/logo/route.ts:48`), which is good.

**The change.** Add `loading="lazy" decoding="async"`. Optionally replace `useEffect(() => setIndex(0), [src, domain])` with `key={src ?? domain}` at the call site, which removes 50 mount effects.

**How to verify.** The Network panel on / should show only the icons in view requested at load.

### 7. Fonts

Drop weight `"700"` from `Silkscreen({...})` in `app/layout.tsx:10`. To verify, grep for bold text inside `ds-pixel` elements and check the `kbd` styling, then look at /settings, /companies and the CV tabs.

Merging Plex 500 into 400 or 600 would save 10 KB of preload on every page. That is a design-system decision (see `docs/DESIGN-SYSTEM.md`), so I have only flagged it.

### 8. CV page code splitting (`next/dynamic`)

These are good candidates for `dynamic(() => import(...))`:
- `CvGapQuiz`: only rendered while a quiz is awaiting answers.
- `CvShareCreateForm`: only rendered once a revision is ready and assessed.
- `CvEvaluationTable`: only inside the evaluation tab.

`CvBuildLive` and `lib/cv-build-narrative.ts` are the bulk of the 68.8 KB chunk, but they render on every CV page in log mode, and the brief asks us not to touch them, so leave them. Expected gain is 5–10 KB gz on /cv/[id] (inferred). There are no dynamic imports anywhere in apps/web today.

On other pages, splitting is not worth it:
- Roles: RolesTable renders immediately.
- Library: the editor is the page.
- Admin and health: 7 KB page chunks.

### 9. Library editor re-parses on the client

`useState(() => openStoredLibrary(library))` runs twice (lines 41 and 50), and the effect at line 118 runs a third time whenever the `library` prop identity changes. It changes on every refresh from `LibraryEvidencePoller` or `LibraryImportPoller`. The input was already opened on the server. Parse once into a shared initial value, and skip the re-open when the prop came from the server. This is only worth doing together with #2.

### Later: selective prefetch

All 62 `<Link>`s use `prefetch={false}`, on purpose (commit `c836da9`, audit WP7: 50 table rows were prefetching the layout 100 times). A narrow reversal would be `onMouseEnter={() => router.prefetch(href)}` on the five sidebar `NavLink`s only, which hides one round trip per sidebar navigation. It would also add layout renders on hover, which is the cost that was removed, so measure before adopting.

## Client/server boundary inventory (39 files)

Traffic: H = Roles, layout, Companies. M = Applications, Library, CV, Suggestions, Settings. L = admin and rare.

| Component | Lines | Why client | Could it be a server component with a client leaf? | Props and payload |
|---|---|---|---|---|
| RolesTable (H) | 677 | selection, keyboard, expand, optimistic removal, undo | No. The interaction spans the whole table | 50 × `RoleRowVM`, a lean projection (`queries/jobs.ts:467-515`; no description, loaded on expand via `roleDetails`). Estimated 1–2 KB/row, so 50–100 KB of RSC per page. `fitRationale` only feeds a `title`. Acceptable |
| ScanStatusBanner (H) | 125 | polling with backoff, relative time | No | small facts object |
| NavLink ×6, WorkspaceNav (H) | 45, 16 | `usePathname` | Could take `active` from the server, but that would lose the client-side highlight. Tiny. Leave | strings |
| NavigationMetrics (H) | 22 | beacon | — | none |
| CompanyFavicon (H) | 35 | `onError` chain | No | two strings |
| SuggestionsStrip (H) | 90 | accept/dismiss | No | at most 5 chips |
| AutoRefresh (M) | 97 | work poller | — | version number |
| SettingsForm (all) | 43 | `useActionState` | Already a leaf around server children | action plus children |
| SearchForm / SearchPending | 55 | transition navigation with pending mark | Already a leaf. `RolesFilterBar` stays a server component | children |
| ConfirmSubmitButton, CopyField, ResetLinkButton, RunScheduledWork, RefreshCompanyButton, FollowCompanyButton | 20–34 | click handlers | Already leaves | scalars |
| ApplicationsTable (M) | 438 | inline stage edits, CV manage, optimistic patch | No | 50 × `PipelineRow` (lean) plus quote sentences |
| SuggestionDeck (M) | 237 | swipe and keys | Shell is client, bodies are server nodes (a good pattern) | **50 server-rendered card bodies; only 2 shown (#4)** |
| CompanyNotepad (M) | 219 | contentEditable editor | No | the notes text |
| CvLibraryEditor + EmploymentHistoryTable, LibraryRowTypeMenu, EvidenceScore (M) | 447 + 99 + 192 + 82 | the editor | No | **whole library JSONB** plus evidence. Required, since it is what is being edited. It appears twice in the HTML (RSC payload plus SSR markup), which is inherent |
| LibraryImportForm, LibraryImportPoller, LibraryEvidencePoller (M) | 87, 50, 74 | upload and pollers | — | scalars |
| CvWorkspace (M) | 195 | tabs, hash following | Takes server children, a good pattern | ReactNodes |
| CvDraftEditor (M) | 382 | editing and preview | No | draft `CvContent` (whole JSONB, needed) plus costs |
| CvBuildLive (M) | 251 | progress stream | Do not touch (brief) | the initial progress reading |
| CvAppearance (M) | 207 | colour pickers | No, but it should not need zod (#2) | theme |
| CvGapQuiz (L) | 123 | quiz form | Could be dynamic | **whole `librarySnapshot`**, though it only needs `entries` and `employment` titles. Pre-shape on the server if it matters. Rare |
| CvEvaluationTable (M) | 230 | filter state | Could be dynamic | evaluation rows |
| CvDisclosure (M) | 29 | open/close | Could be native `<details>`, but it is tiny | children |
| CvShareCreateForm (L) | 67 | form | Could be dynamic | scalars |
| DiscoverySourceForm, DiscoverySourceFields (L) | 32, 15 | form state | Already leaves | scalars |
| Elapsed, ElapsedTime (L) | 26, 23 | 1 s or 15 s ticks | Bounded (CV progress and company setup timeline only) | numbers |
| `app/(app)/error.tsx` | 40 | error boundary (must be client) | — | — |

**Timers per page.** The layout holds 1 minute-long interval plus 1 backoff timeout from ScanStatusBanner, which is hidden-tab aware. AutoRefresh adds 1 timeout only while work is active. A CV build adds 1 s ticks plus the progress poll. There is no unbounded fan-out.

## Next config (`apps/web/next.config.ts`)

- No setting hurts the client: `reactStrictMode` has no production effect, and `compress` is at its default (Vercel compresses anyway).
- There is no `images` config because `next/image` is not used, correctly: icons are tiny and remote, and logos come from the app's own route.
- There is no `optimizePackageImports`, which is fine because there are no large barrel packages. The only barrel is `@/components/brand`, and it is tiny.
- `experimental.serverActions.bodySizeLimit: "6mb"` only affects uploads.
- `@next/bundle-analyzer` is not installed. The manifest script above does the job. If the owner wants a treemap, add the analyzer as a devDependency behind `ANALYZE=1`. That is optional.

## The three I would do first

1. **#1: drop the redundant `router.refresh()` calls.** It is a one-line deletion at each site, halves the server work of the single most frequent write (triage on Roles), and the owner already made the same change for archive. It is correct by construction because Next re-renders the current page whenever an action revalidates.
2. **#2 for /settings: make `CvAppearance` zod-free.** A mechanical module split takes about 30 KB gz and about 100 KB of parse off a page, and puts the pattern in place for the heavier CV and Library follow-up.
3. **#3: stabilise `rows` in RolesTable.** A two-line `useMemo` stops a listener re-subscribing and a forced layout on every keystroke. If the browser check confirms the scroll jump, it also fixes a visible defect on the main page.

## Checked and already good

- No server-only code in any client chunk. Only one third-party library (zod) reaches the client.
- The roles table is server-paginated at 50 rows (`queries/jobs.ts:740,747`) with a lean view model. Role details (the description, the CV quote) load on expand through one action call and are cached per row for the page.
- Sorting and filtering happen in SQL. There is no client-side sort or filter of big arrays. Heavy client computations in the Library editor are memoised (`CvLibraryEditor.tsx:64-82`).
- `SearchForm` navigates by transition instead of a full reload and shows a pending mark. Filter and sort links carry state in the URL and are server-rendered.
- Pollers back off, stop, and respect hidden tabs. The banner staggers wake-ups over a minute.
- Fonts use `next/font` (self-hosted, swap, latin subset, metric fallbacks). There are no render-blocking third-party requests. CSS is a single 8.5 KB gz file.
- Company logos have width and height set, so no layout shift. The logo route caches versioned URLs as immutable for a day.
- Server-content-in-client-shell composition (SuggestionDeck cards, CvWorkspace, SettingsForm) keeps most markup out of client bundles.
- `prefetch={false}` everywhere is a deliberate, documented trade (WP7).
