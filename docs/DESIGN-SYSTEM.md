# Course of Life design system

Brand-green chrome, crisp white screens, black ink, deep-grey support text, four
status hues. Silkscreen for brand headings,
IBM Plex Mono for everything else. Radius 0, hard offset shadows, stepped
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

Functional labels, navigation, table headers and buttons use IBM Plex Mono at 13–14px or above. Keep the pixel face for brand headings rather than small action text. Shared buttons have a minimum 44px target. On phones, fields use 16px text to remain readable and avoid focus zoom; buttons and disclosure summaries have a 44px minimum height. Preserve visible keyboard focus on links, fields, summaries and editable text.

The desktop sidebar becomes a labelled Menu disclosure on phones, with one navigation tree. Escape closes it and returns focus to its trigger. Health and Learning are direct destinations. Core work lists must keep the item and its actions together at 320px and 390px; evidence editing has one input per field rather than hidden duplicate required controls. Dense secondary metadata may remain smaller, but must not carry the primary action or only explanation.

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
| Faint | `text-faint` | `#888` | Placeholders — the dimmest legible step (3.5:1) |
| Line | `border-line` | `#000` | The structural 2px border: cards, buttons, tables |
| Line muted | `border-line-muted` | `#bbb` | Input borders, filter bars, the status strip's 1px rule |
| Line faint | `border-line-faint` | `#ddd` | Table row rules |
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

Silkscreen (pixel, uppercase by typeface) for page and brand section titles,
compact badges and numerals near the mark. Never for a paragraph or primary action label.
IBM Plex Mono for all body text and controls. Both are self-hosted through
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

Radius 0 everywhere; the radius scale is empty. Borders are 2px structurally,
1px for hairlines, 4px for emphasis. Shadows are hard offsets with no blur:
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

## The mark

The mark is a C-shaped path and a point. The path is the wordmark's own C — a
square pixel C with its corners cut by one stroke — drawn on a 24×24 cell tile
with 2-cell strokes, and a 4×4 point sits at its opening on the baseline, lower
right, where the path leads: a course, and where it arrives. The point is at the
opening rather than the centre because a point inside a C reads as a copyright
sign. With the wordmark it is the only graphic in the product. The glyph rows live in
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

There is no icon set, and adding one would break the system. Company favicons
are the only pictorial elements (14–16px squares, falling back to a grey
square). Status is carried by badges with text, links by underline, external
links by " ↗", keys by `<kbd>`. The one chevron — on `<select>` — is drawn as two
CSS triangles by the `ds-select` utility. If a glyph is unavoidable, draw it on
the 16-cell grid in `currentColor`.

---

## Components

`apps/web/components`. Compose these rather than restyling raw elements.

| Component | Notes |
| --- | --- |
| `Button` | Silkscreen uppercase. `primary` light green on brand green with a 4px shadow, `secondary` raised with a full-contrast border, `danger` the danger hue, `ghost` muted text that underlines. `buttonClass()` for links and submit buttons that cannot be a `<Button>`. |
| `Card` | 2px border on `bg-raised`, pixel title bar, `raised` for the 8px shadow. |
| `Badge` | Outline and text in one tone; the tone helpers map app states to roles. `toneText` gives the same tone as ink alone, for secondary text under a badge. |
| `PageHeader` | Silkscreen 20px title over a 2px rule. |
| `EmptyState` | Dashed 2px border, pixel title. |
| `table.tsx` | `Table`/`THead`/`TBody`/`TR`/`TH`/`TD` plus `FitBar`, the ten stepped cells. `TR highlighted` is the keyboard cursor. |
| `Field` | `Field`/`Input`/`Textarea`/`Select`/`Checkbox`, and the `inputClass`, `selectClass` and `labelClass` strings for server components that style raw inputs. |
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
