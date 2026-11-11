# Course of Life design system

Brand-green chrome, crisp white screens, black ink, deep-grey support text, four
status hues. Silkscreen for brand moments, IBM Plex Mono for navigation and controls,
and the system sans face (`ds-prose`) for narrative answers and drafts. Radius 0, hard offset shadows on primary actions, stepped
motion. The UI supports keyboard review and narrow-screen work, so the system is
deliberately small — if you reach for a colour or a size that is not here, that
is a signal to reuse something, not to add a token.

Tokens live in `apps/web/app/globals.css` in two layers: raw and semantic custom
properties on `:root`, then an `@theme` block that hands the semantic names to
Tailwind. That block **clears Tailwind's default colour, radius, shadow, type
and font scales** before defining ours, so `text-slate-500`, `rounded-lg` and
`shadow-sm` do not exist. A missing utility means a missing token, not a reason
to write an arbitrary value.

## Functional reading and interaction

Functional labels, navigation, table headers and buttons use IBM Plex Mono at 13–14px or above. Keep the pixel face for brand headings rather than small action text. Shared buttons have a minimum 44px target. On phones, fields use 16px text to remain readable and avoid focus zoom; buttons, tabs and checkbox labels have a 44px minimum target. Preserve visible keyboard focus on links, fields and editable text. Do not suppress the shared outline with a component-level `focus:outline-none`.

The desktop sidebar becomes a labelled Menu disclosure on phones, with one navigation tree. Escape closes it and returns focus to its trigger. Roles, Companies, Applications and Experience are primary destinations; Preferences, Search profile and Needs attention are a quieter secondary group. Account and the plan readout remain at the foot. Core work lists must keep the item and its actions together at 320px and 390px; evidence editing has one input per field rather than hidden duplicate required controls. Dense secondary metadata may remain smaller, but must not carry the primary action or only explanation.

Ordinary cards and tables use a single faint border and quiet dividers. Reserve heavy outlines for alerts, focused controls and deliberate emphasis. Page titles, card titles and badges use readable functional type. This applies to the application's chrome, not the user's chosen CV document theme.

---

## Colour

The sidebar and the sign-in panel are brand green with light-green copy. Every
screen they frame is white, with black for main information and a deep grey for
support text. Greys are for structure only — sunken surfaces, support text,
hairlines, hard shadows. The four status hues are used as full-opacity ink or
outline, always with text beside them. There are no tinted fills.

There is one scheme. The dark ground and its unused `[data-theme="light"]`
inverse are gone; nothing branches on a theme.

### Base

Black `#000000` · White `#ffffff` · `#111111` · `#1a1a1a` · `#2a2a2a` ·
`#444444` · `#666666` · `#888888` · `#bbbbbb` · `#dddddd` · `#f2f2f2`

Brand green `#25593a` · deep green `#1c4a2e` · light green `#e8fecc` · soft
green `#b8d9a0`

### Semantic roles

Each is a custom property on `:root` and a Tailwind utility. Reach for the
utility, not the raw value.

| Role | Utility | Value | Use |
| --- | --- | --- | --- |
| Ground | `bg-bg` | `#fff` | The page |
| Raised | `bg-raised` | `#fff` | Cards, the status strip |
| Sunken | `bg-sunken` | `#f2f2f2` | Table heads, expanded rows, hover, the verify banner |
| Ink | `text-fg` | `#000` | Main information |
| Muted | `text-muted` | `#444` | Support text, table heads, ghost buttons (9.7:1) |
| Faint | `text-faint` | `#888` | Non-essential placeholders only (3.5:1); never the only label or instruction |
| Line | `border-line` | `#000` | Emphasised outlines and 2px control borders |
| Line muted | `border-line-muted` | `#bbb` | Input borders, filter bars, the status strip's 1px rule |
| Line faint | `border-line-faint` | `#ddd` | Ordinary card outlines, page rules and table dividers |
| Track | `bg-track` | `#ddd` | Unfilled fit cells, favicon fallbacks |
| Highlight | `bg-highlight` | `#f2f2f2` | The keyboard cursor row (its 4px left rule is brand green) |
| Accent | `bg-accent` / `text-accent-fg` | `#e8fecc` on `#25593a` | Primary buttons, selected tabs |

`line` rather than `border`, so utilities read `border-2 border-line` instead of
`border-border`. The focus ring is brand green on white, the text selection a
22% brand-green wash, and the hard shadow `#888` so it reads on white.

### Brand

| Role | Utility | Value | Use |
| --- | --- | --- | --- |
| Brand | `bg-brand` / `text-brand` / `fill-brand` | `#25593a` | The sidebar, the sign-in panel, the mark on white, the favicon |
| Brand hover | `bg-brand-hover` | `#1c4a2e` | Hover on green (sidebar entries) |
| Brand ink | `text-brand-ink` / `bg-brand-ink` / `fill-brand-ink` | `#e8fecc` | Copy on green (7.6:1), the lit sidebar entry's block, the mark on green |
| Brand ink muted | `text-brand-ink-muted` | `#b8d9a0` | Secondary copy on green: the account line, the tagline (5.2:1) |

`ds-on-brand` is the utility for anything on the green: it sets the green
ground and light-green ink, and switches the focus ring and selection to the
light green so they do not vanish into their own colour.

### Status

| Role | Utility | Value |
| --- | --- | --- |
| OK | `ok` | `#1a7f4b` |
| Warning | `warn` | `#9a6400` |
| Danger | `danger` | `#c62828` |
| Info | `info` | `#1f5fa8` |

Each is at least 5:1 on white.

---

## Typography

Silkscreen (pixel, uppercase by typeface) is reserved for brand moments and numerals near the mark. Functional page headings, card titles, badges and controls use IBM Plex Mono. Narrative career answers and CV drafts use the system sans face through `ds-prose`; neither pixel type nor dense mono text should impede sustained reading. Silkscreen and IBM Plex Mono are self-hosted through
`next/font` in `app/layout.tsx`: Silkscreen at 400 only (there is no pixel bold;
a pixel element in a bold context such as a `<th>` carries `ds-pixel` itself),
Plex Mono at 400, 500 and 600 with a system monospace fallback stack rather than
a size-adjusted Arial. `body` carries
`font-variant-numeric: tabular-nums` so figures line up in tables.

Sizes are named for their pixel value, because the scale is small and literal.

| Utility | Use |
| --- | --- |
| `text-9` | Legacy compact badges; never essential instructions |
| `text-10` | `<kbd>` and supplementary indicators |
| `text-11` | Supplementary metadata |
| `text-12` | Brand card titles, secondary metadata |
| `text-13` | Functional labels, table headers, small buttons, links and status |
| `text-14` | Body, navigation and controls — the default |
| `text-16` | Section headings |
| `text-20` | Page titles |
| `text-24` | Display figures |

`ds-pixel` carries the brand idiom (Silkscreen, uppercase, `tracking-pixel`).
`ds-label` uses readable 13px medium mono text with normal tracking and muted ink for field labels. Tracking tokens are `tracking-pixel` 0.02em, `tracking-badge` 0.04em,
`tracking-th` 0.08em, `tracking-label` 0.16em.

---

## Shape and spacing

Radius 0 everywhere; the radius scale is empty. Ordinary cards and separators use 1px faint borders. Inputs and buttons use 2px borders, with 4px reserved for deliberate emphasis. Shadows are hard offsets with no blur:
`shadow-hard-1` (2px), `shadow-hard-2` (4px, primary and danger buttons),
`shadow-hard-3` (8px, the raised sign-in card, which sits on white beside the
green panel carrying the wordmark). `inset-shadow-cursor` is the 4px
rule down the left of the keyboard cursor row. `ds-divider` draws the dotted
rule: 2px dots on a 4px pitch.

Spacing runs on the 4px scale in whole multiples. Sidebar 192px, content padding
24px, card padding 16px, table cells 12×8, minimum hit target 44px. The status
strip and the verify banner sit on white under a 1px `line-muted` rule; the
sidebar has no border, its green is the edge.

---

## Motion

Stepped, never eased. `ease-step-2` and `ease-step-4`, at 120/240/480ms.
While something is loading, a blank pixel passes through the mark: one cell
painted in the ground colour (`--mark-ground`, the page white, or the green
inside `ds-on-brand`) steps through the artwork's filled cells in plotter order
— columns left to right, each column top to bottom — one cell per 32ms beat,
stepped rather than interpolated, looping, as if the mark were being redrawn.
The beat is the same for every form, so a bigger artwork takes longer rather
than moving faster: the small mark's 63 cells come round in 2s, the mark's 96 in
3.1s, the wordmark's 187 in 6s.
The mark is still everywhere except the one loading indicator in view.
`prefers-reduced-motion` stops every CSS animation and hides the blank cell, so
the mark simply stands still.

---

## States

Hover inverts the fill (black on white ↔ white on black; a primary button goes
from green to white) or underlines; on the green sidebar it deepens the green. Press
collapses the shadow and shifts the control +2,+2 — that is the `ds-press`
utility, applied by `Button`. Focus is one 2px ring at 3px offset, set once in
`globals.css` for every control; **components must not set their own**, because a
Tailwind `focus-visible:outline-*` utility outranks that rule. Disabled is 40%
opacity.

---

## Workflow and state contracts

Customer CV, Experience, opportunity and application tasks do not hide essential controls in accordions, details elements or “More options”. Put a distinct task on a named destination; keep the current task’s controls visible. The phone Menu is navigation, and the three-action writing menu is the expressly approved contextual exception. Admin diagnostics are separate from customer work.

Use `TaskNavigation` for local tasks that share a workspace: CV Edit/History/Compare/Role details, Experience Records/Import/Writing, import methods and record editing tasks. A tab selects a panel, not an editing policy. Auto/Refine/Manual remain separate mode choices. Use ordinary links for real route navigation. Preserve existing fragment IDs, and link every tab to its panel with `aria-controls` and `aria-labelledby`.

Task switches must retain dirty buffers. Keep visited editors mounted and hide inactive panels; do not use the selected tab as a remount key. A task change must not submit, queue AI or write data. Heavy editors may load on first visit, with an accessible loading state, but subsequent visits reuse the mounted editor. Pending work and source refreshes must distinguish an acknowledged child save from an external version change. Preserve or explicitly recover unsaved work instead of silently replacing it.

| State | Required behaviour |
| --- | --- |
| Empty | Name what is missing and show a direct next action. Do not display an unexplained disabled primary action. |
| Editing | Keep the current document and task identifiable; inputs retain their values across task switches. |
| Saving | Prevent duplicate submission; retain text typed while the submitted snapshot is in flight. |
| Saved | Acknowledge the saved snapshot only. If newer edits exist, show “You have unsaved changes.” rather than claiming the visible draft is saved. |
| Validation failure | Focus the invalid native control; link the error to the form/action and preserve all inputs. |
| Retry | Clear the obsolete error while the retry is pending; show the new result when it settles. |
| Source changed | Preserve the local buffer and provide the workflow’s recovery action. Do not present a stale buffer as the current saved CV. |
| Background work | Show the current stage without exposing provider diagnostics to ordinary users; completion must not overwrite active edits. |

These primitives standardise presentation and interaction, not business policy. Role credits, AI allowances, explicit proposal use, finalisation consent and immutable PDF rules remain governed by [ADR0008](adr/0008-role-entitlements-and-contextual-editing.md). The wider task/state inventory is in the [journey map](ux/journey-state-map.md).

## Frontend implementation discipline

Reuse shared primitives before adding local variants. Keep server-rendered content on the server and introduce client boundaries only for interaction; avoid importing server utilities through a client barrel. Prefer event-driven state updates, stable IDs and one owner for each editable buffer. Independent data reads can run together; do not add network work to navigation or input handlers. Keep long labels and nested flex/grid children shrinkable, and use existing status tokens (`ok`, `warn`, `danger`, `info`) rather than undefined aliases such as `success`.

Verify behaviour rather than merely matching classes: keyboard focus and tab order, retained input after task switches and failed saves, fast edits during save acknowledgement, and actual 320px/390px layout. A successful build and component suite cannot establish visual quality or human comprehension by themselves. Route bundle budgets remain unchanged for this consolidation; deferred panels must not make ordinary navigation silently load every editor.

---

## The mark

The mark is a C-shaped path and a point. The path is the wordmark's own C — a
square pixel C with its corners cut by one stroke — drawn on a 24×24 cell tile
with 2-cell strokes, and a 4×4 point sits at its opening on the baseline, lower
right, where the path leads: a course, and where it arrives. The point is at the
opening rather than the centre because a point inside a C reads as a copyright
sign. Together with the wordmark it provides the product’s brand artwork. The glyph rows live in
`components/brand/mark-cells.ts` and are the single source: `Mark.tsx`,
`MarkSmall.tsx` and `Wordmark.tsx` render them on the page, and
`scripts/generate-brand-assets.ts` renders the favicon, the installed-app icons,
the SVGs and the PNG sizes in `public/brand/` from the same data, so the tab and
the page can never drift.

- **The mark.** `Mark` draws the 24-cell tile (`MARK_TILE`). It appears at 72
  above the wordmark on the sign-in panel, and is the installed-app and
  home-screen icon: centred on white for `apple-icon` and the plain manifest
  icons, light green on a green ground inside the safe zone for the maskable one.
- **The small mark.** `MarkSmall` is the same artwork on its own 16×16 tile
  (`MARK_SMALL_TILE`), because it must be crisp at 16px, where the 24-cell tile
  would put two thirds of a pixel in each cell. It is the favicon (green on a
  transparent ground), the status strip's mark, and every inline loading
  indicator at 16px.
- **The wordmark.** `Wordmark` is the domain, stacked: `COURSE` over `OF.LIFE`,
  in 5×7 pixel capitals with 1-cell strokes and two empty rows between the
  lines, 50×16 cells (`WORDMARK_WIDTH`, `WORDMARK_TILE`). **Both lines are
  justified to one measure of 50 cells**, so the stack is a rectangle: the
  tracking is whatever makes the measures agree — the first line's six letters
  sit 4 cells apart, the second line's seven slots 3 apart. The dot is a 2×2
  square on the baseline and takes a slot of its own, tracked like a letter,
  rather than tucking into the space between F and L. `mark-cells.ts` refuses to
  load if the lines disagree, so a change to either line has to be balanced in
  the other (`WORDMARK_LINES` holds each line's text and gap). It heads the
  sidebar at 32, sits under the mark on the sign-in panel at 64, and is the
  loading indicator for a whole page or a CV build.
- **Colour follows the ground.** Every form is drawn in `currentColor`: light
  green (`text-brand-ink`) on the sidebar and the sign-in panel, brand green
  (`text-brand`) on white — the status strip, the loading page and a CV build.
  The inline indicators take the colour of the text they sit beside. There are
  no fixed fills.
- `size` is the height, snapped to a whole multiple of the tile so cells land on
  device pixels; the width follows the artwork. `Mark` snaps to 24 (24, 48, 72),
  `MarkSmall` to 16 (16, 32, 48), `Wordmark` to 16: 32 gives 100×32 in the
  sidebar, on the loading page and on a CV build, 64 gives 200×64 on the
  sign-in panel. The sidebar and the CV build use 32 rather than 48 because on
  a 320px phone the sidebar link shares the header row with the plan readout
  and the Menu button, and the build card's heading sits beside the wordmark;
  150px would leave either almost no room.
- `searching` redraws it, and that is the product's **only loading indicator**:
  a page loading (`loading.tsx`, the wordmark at 32), a CV building
  (`CvBuildProgress`, the wordmark at 32), a search or filter in flight
  (`SearchPending` inside a `SearchForm`), a description loading, a follow or a
  suggestion saving (the small mark at 16). Everywhere else — sidebar, sign-in,
  the status strip — the mark is still. A mark that is always moving tells the
  user nothing.
- The blank pixel (see Motion) is a 1×1 `<rect class="ds-mark-blank">` after the
  artwork, whose `x` and `y` are stepped by two SMIL `<animate>`s with
  `calcMode="discrete"` through the order in `MARK_CELLS`, `MARK_SMALL_CELLS` or
  `WORDMARK_CELLS`, so no CSS is generated per artwork. `globals.css` only paints
  it in `--mark-ground` and hides it under reduced motion.
- Each form is one `<svg>` with one `<path>` of horizontal runs (`MARK_PATH`,
  `MARK_SMALL_PATH`, `WORDMARK_PATH`), not one element per cell, because every
  mark on a page is serialised into the payload of every navigation.
- Clear space is half the artwork's height on every side.
- Regenerate assets with `pnpm exec tsx scripts/generate-brand-assets.ts`. It
  writes `app/icon.svg` and `app/favicon.ico` (the small mark), `app/apple-icon.png`,
  and in `public/brand/`: `mark.svg` (currentColor), `mark-green` and
  `mark-light` SVGs and PNGs at 24/48/96/192; `mark-small.svg`,
  `mark-small-green.svg` and PNGs at 16/32/48/64; `wordmark.svg`,
  `wordmark-green` and `wordmark-light` SVGs and PNGs at 32/48/64/96; and
  `app-icon-192`, `app-icon-512` and `app-icon-maskable-512`.

---

## Iconography

There is no general-purpose icon library. Company favicons are 14–16px squares, falling back to a grey square. The contextual CV writing action uses three pixel stars with the exact tooltip “Help me write”; it opens the three approved text actions and has no shortcut hint. Status is carried by badges with text, links by underline, external
links by " ↗", keys by `<kbd>`. The one chevron — on `<select>` — is drawn as two
CSS triangles by the `ds-select` utility. If a glyph is unavoidable, draw it on
the 16-cell grid in `currentColor`.

---

## Components

`apps/web/components`. Compose these rather than restyling raw elements.

| Component | Notes |
| --- | --- |
| `Button` | Readable 13–14px mono, minimum 44px target, wrapping labels and native button semantics. `primary` light green on brand green with a 4px shadow, `secondary` raised with a full-contrast border, `danger` the danger hue, `ghost` muted text that underlines. `buttonClass()` for links and submit buttons that cannot be a `<Button>`. |
| `Card` | Quiet 1px faint border on `bg-raised`, 16px functional heading; `raised` explicitly adds the 2px outline and 8px shadow. Titles and action rows wrap independently. |
| `Badge` | Outline and text in one tone; the tone helpers map app states to roles. `toneText` gives the same tone as ink alone, for secondary text under a badge. |
| `PageHeader` | Functional 20px h1 above a faint 1px rule. Actions occupy their own full-width row on phones and wrap alongside the title on larger screens. |
| `EmptyState` | Dashed 2px border, readable 16px h2, brief explanation and one next action. Content stays inside narrow screens. |
| `table.tsx` | `Table`/`THead`/`TBody`/`TR`/`TH`/`TD` plus `FitBar`, the ten stepped cells. `TR highlighted` is the keyboard cursor. |
| `Field` | `Field`/`Input`/`Textarea`/`Select`/`Checkbox`, and the `inputClass`, `selectClass` and `labelClass` strings for server components that style raw inputs. |
| `TaskNavigation` | Controlled, labelled task tabs with linked panels, roving tab stop, Arrow/Home/End navigation and disabled-item skipping. Callers supply a valid enabled active task and retain panel state. |
| `SettingsForm` | Native validation, pending protection, linked errors, retry and truthful saved/unsaved acknowledgement. Does not reset edits made while a request is pending. |
| `NavLink` / `WorkspaceNav` | Sidebar items are light green on the brand green; the active one is a light-green block with green text. Workspace links underline over a dotted rule. |
| `CompanyNotepad` | The company note. A `contenteditable` in the `Field` control shape — 2px muted border on the page ground, full-contrast on focus — with a Bold / Bullet list toolbar, `Saved HH:MM` or `Unsaved changes`, and a primary Save. `ds-notepad` draws the bullets and paragraph rhythm the browser's own `ul`/`p` would otherwise lose to preflight. Stored text is converted through `lib/notes-markdown`, never `innerHTML`. |
| `Mark` | The mark on its 24-cell tile: the sign-in panel and the app icons. Above. |
| `MarkSmall` | The same artwork on a 16-cell tile: the favicon, the status strip and every 16px loading indicator. Above. |
| `Wordmark` | `COURSE` over `OF.LIFE`, 50×16: the sidebar, the sign-in panel, the page and CV-build loading indicators. Above. |

---

## What this replaced

The previous system was a light navy-and-slate one: accent `#142D46`, a slate
neutral ramp, rounded corners, and a four-drum enamel mark with its own brand
palette (rust, brass, verdigris, slate). All of it is retired — the palette, the
`accent-hover` and `accent-tint` tokens, `ChristopherMark`/`Wordmark`/`Lockup`
and `components/brand/artwork.ts`. The pixel wheel that followed it (one drum of
the Bombe, its dial opening the ring into a "C", turned by `animate-paddle`) gave
way to the AVA wordmark when the product was renamed. The AVA system itself
began black-ground, white-ink with an unused light inverse, and a looser
wordmark on a 16-cell tile (pitch 16, four empty cells between letters); the
green chrome, white screens, the kerned 24-cell wordmark and the triangle
monogram replaced them.

When the product was renamed Course of Life, the AVA wordmark (A V A on kerned
24-cell tiles), the triangle monogram with its knocked-out A, and the animation
that turned each letter about its own axis were retired. The Course of Life
mark, its 16-cell small form and the stacked wordmark replace them, and the
blank pixel replaces the turn. The first Course of Life drawing — a junction, a
point with three paths leaving it, over a lowercase `course of.life` wordmark 29
cells wide, redrawn on a 48ms beat — gave way to the C-shaped path with its
point, the uppercase wordmark justified to 50 cells and the 32ms beat.

The CV document palettes in `components/CvAppearance.tsx` and `lib/cv-pdf.ts`
are deliberately **not** part of this system. A CV is a document the user styles
for an employer, not app chrome, and it keeps its own colours.

## Frontend consolidation — 11 November 2026

This pass consolidates shared interaction and layout patterns; it is not a claim that every screen has undergone a new visual redesign.

| Area reviewed | Implemented change | Behavioural evidence |
| --- | --- | --- |
| Shared controls and surfaces | Shrinkable, wrapping Button/Card/PageHeader/EmptyState; consistent field targets, disabled/invalid treatment and shared focus outline; contextual Refine text stacks above its action on phones | Native control/heading semantics and the component suite; production phone/focus checks below |
| CV and Experience task navigation | One `TaskNavigation` primitive across CV tasks, Experience tasks, import sources and career-record editing tasks | Arrow/Home/End navigation, disabled-item skipping, stable panel links and retained unsent text |
| Save acknowledgement and recovery | `SettingsForm` links errors, clears obsolete retry errors and distinguishes submitted content from newer unsaved edits | Validation, failed retry, typing during saves and externally associated controls covered |
| Status and visual language | Replace undefined `success` utilities with existing `ok` tokens; align documented typography, borders and contextual writing icon with implementation | Existing affected component tests; no new colour or spacing scale |
| Frontend maintenance | Keep task state controlled, panel identity stable and server/client boundaries narrow; document one set of reusable contracts | All workspace typechecks and production build pass; existing route budgets unchanged |

Local verification: **327 tests across 74 component files passed**, as did all workspace typechecks and the production build. Final targeted status/navigation and responsive Refine passes also passed 18 and 23 tests respectively. These overlap with the component suite and are not an additional independent coverage total. Every route passed the existing JavaScript budget: CV workspace 136,504/138,000 gzip bytes, Experience 125,553/142,000, About 114,125/115,000 and shared root 102,482/104,000. Both production browser suites passed on the final build. The CV modes journey checks Arrow/Home/End task switching, retained dirty Refine wording, current-version saves, source/history recovery, immutable final PDF bytes and application recording. At 320px and 390px it verifies contained controls; at 320px it also checks readable source rows (at least 160px wide), 44px task targets and the computed 2px green Field focus outline with 3px offset. Screenshots were inspected after correcting the squeezed Refine text/action row. The wider smoke covers page rendering, security headers, legacy CV and tailoring flows, Applications, direct career capture, recommendations and Experience review. No browser console errors were reported by the modes journey.

Verification logs: `/tmp/col-frontend-components.log`, `/tmp/col-frontend-types.log`, `/tmp/col-frontend-build-final.log`, `/tmp/col-frontend-budget-final.log`, `/tmp/col-frontend-design-modes-final.log` and `/tmp/col-frontend-design-web-fresh.log`. The final broad smoke used a fresh migrated sibling database after a provisional reused fixture database produced state collisions; its assertions were retained. Screenshot artefacts are under `/tmp/cv-modes-browser/`, including `mobile-320-long-label.png` and `field-focus-320.png`. These local paths are diagnostic artefacts, not permanent repository assets. Hosted checks remain pending at this checkpoint.

Human comprehension and usability evaluation remain outstanding: use the task protocol in the journey map to check whether people identify the current CV, understand edit scope and recover without assistance. Automated acceptance and screenshots cannot answer those questions. No production deployment or live AI qualification is part of this frontend pass.

## Opportunity screens and states — follow-up

Roles, Companies and Applications keep route navigation as ordinary links with meaningful URLs. Local task tabs and route filters are different controls: the former retain a mounted workspace panel; the latter choose a new result set. Application progress, reminder focus and stage remain distinct concepts, presented together in one labelled filter region instead of three competing navigation strips. Due counts open the complete focused list; a second miniature copy of the same results is unnecessary.

| Screen/state | Contract |
| --- | --- |
| Roles loading or empty | Keep the selected filters identifiable while results load. Distinguish an empty match list from pending or failed monitoring through the existing setup guidance. The checklist and empty-state notice share one authenticated request’s setup facts. |
| Companies list | Show monitoring health alongside the company. Manage is an ordinary link to that company’s management destination; list rows do not load the interactive management action module. |
| Applications filtered empty | Explain the active focus/stage, offer a direct route back to applications, and retain the company scope until the person explicitly chooses all companies. A genuinely new application list links to Find roles. |
| Add an application | Use the named `/applications/new` task, reached by the visible Add a role link. Keep its entry form off the working application list. |
| Applications populated | Keep progress, due/overdue focus and stages visible, selected states exposed with `aria-current`, and counts available without repeating a second preview list. |
| Application editing | Leaving an unsaved update must be deliberate. A successful application status save only clears the submitted revision; newer typing remains unsaved. CV-side inputs are conservatively guarded when a reliable save acknowledgement is unavailable. New-tab, download and same-page fragment links must not behave like destructive task exits. |
| Route loading | Name Companies or Applications while loading. Decorative skeletons are hidden from assistive technology; the shared brand indicator is the single moving element. |
| Unexpected failure | Preserve production error redaction and a diagnostic reference. Retry exposes pending state and rejects rapid duplicate clicks; it does not promise that an unsaved form survived an error-boundary remount. |

Performance changes should remove actual work before introducing caches. Applications reads its pipeline once per page rather than hydrating a second page of due rows to display three titles. Roles explicitly shares an in-flight setup promise and overlaps independent setup/count reads; this is request-local, not a cross-account cache. Visibility-aware polling remains unchanged. Measure route JavaScript independently from server query work and report increases as well as reductions; neither fewer queries nor smaller bundles alone proves a real-user speed improvement.

Local checkpoint: **330 tests across 74 component files** and **6 route/state tests across 4 files** pass, alongside all workspace typechecks and the production build. The component suite includes dirty application navigation and typing during a save; route tests cover authentication on the new entry task, scoped empty recovery, loading semantics and guarded retry. All existing bundle caps pass without changes. Companies falls from 117,950 to 116,374 gzip bytes and nine to eight chunks; Applications falls from 125,768 to 125,520. The new `/applications/new` route is 113,749/115,000. Roles rises from 131,073 to 131,420, while shared root remains 102,482/104,000. These are same-machine build measurements, not user-perceived performance claims. Final production browser acceptance and screenshot review are pending at this checkpoint.

Logs: `/tmp/col-opportunity-ui-final.log`, `/tmp/col-opportunity-states-final.log`, `/tmp/col-opportunity-types-final.log`, `/tmp/col-opportunity-build-final.log` and `/tmp/col-opportunity-budget-final.log`. Human usability evaluation, production deployment and live AI qualification are not claimed by this follow-up.
