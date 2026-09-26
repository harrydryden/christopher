# AVA design system

Brand-green chrome, crisp white screens, black ink, deep-grey support text, four
status hues. Silkscreen for headings and labels,
IBM Plex Mono for everything else. Radius 0, hard offset shadows, stepped
motion. The UI is a dense keyboard-first table app, so the system is
deliberately small — if you reach for a colour or a size that is not here, that
is a signal to reuse something, not to add a token.

Tokens live in `apps/web/app/globals.css` in two layers: raw and semantic custom
properties on `:root`, then an `@theme` block that hands the semantic names to
Tailwind. That block **clears Tailwind's default colour, radius, shadow, type
and font scales** before defining ours, so `text-slate-500`, `rounded-lg` and
`shadow-sm` do not exist. A missing utility means a missing token, not a reason
to write an arbitrary value.

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
| Brand | `bg-brand` / `text-brand` / `fill-brand` | `#25593a` | The sidebar, the sign-in panel, the mark on white, the monogram's triangle |
| Brand hover | `bg-brand-hover` | `#1c4a2e` | Hover on green (sidebar entries) |
| Brand ink | `text-brand-ink` / `bg-brand-ink` / `fill-brand-ink` | `#e8fecc` | Copy on green (7.6:1), the lit sidebar entry's block, the monogram's A |
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

Silkscreen (pixel, uppercase by typeface) for page and section titles, button
labels, badges, table heads and numerals near the mark. Never for a paragraph.
IBM Plex Mono for all body text and controls. Both are self-hosted through
`next/font` in `app/layout.tsx`; `body` carries
`font-variant-numeric: tabular-nums` so figures line up in tables.

Sizes are named for their pixel value, because the scale is small and literal.

| Utility | Use |
| --- | --- |
| `text-9` | Badges, table heads |
| `text-10` | `<kbd>`, fit scores, field labels, small buttons |
| `text-11` | Sidebar and tab navigation |
| `text-12` | Card titles, secondary text, buttons |
| `text-13` | Links, the status strip, pagination |
| `text-14` | Body and every control — the default |
| `text-16` | Section headings |
| `text-20` | Page titles |
| `text-24` | Display figures |

Two utilities carry the pixel idiom: `ds-pixel` (Silkscreen, uppercase,
`tracking-pixel`) and `ds-label` (10px, `tracking-label`, muted) for field
labels. Tracking tokens are `tracking-pixel` 0.02em, `tracking-badge` 0.04em,
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
`--animate-mark-turn` turns the mark while something is loading: each letter
turns once about its own upright axis in eight 45° jumps on a 200ms beat (its
width is the cosine of the angle, so it narrows to an edge and comes back
mirrored), one beat behind the letter before it, then all three rest upright
together before the 2.4s cycle repeats. `prefers-reduced-motion` stops every animation.

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

A V A in three pixel letters, each drawn on its own 24×24 cell tile with 3-cell
strokes. The letter box is columns 2–21 and rows 2–21 of its tile, so its centre
is the tile centre. Both letters are all diagonal: every stroke steps one cell
outward each two rows, from a two-cell point to a twenty-cell base, so the A is
an upside-down V with a 3-row bar two thirds of the way down and the V is that
outline turned over; neither has a vertical side. It is the only graphic in the
product. The glyph rows live in `components/brand/mark-cells.ts` and are the
single source: `Mark.tsx` and `Monogram.tsx` render them on the page, and
`scripts/generate-brand-assets.ts` renders the favicon, the installed-app icons,
the SVGs and the PNG sizes in `public/brand/` from the same data, so the tab and
the page can never drift.

- **The mark is the wordmark.** `Mark` sets the tiles at x = 0, 14 and 28 on a
  52×24 grid (`TILE` 24, `PITCH` 14). The letters are kerned: their boxes
  overlap, and each A leg runs parallel to the V leg beside it with three empty
  cells between them, one stroke of air all the way down. Two empty cells remain
  at each edge. There is no separate logotype.
- **Colour follows the ground.** The wordmark is drawn in `currentColor`: light
  green (`text-brand-ink`) on the sidebar and the sign-in panel, brand green
  (`text-brand`) on white — the loading page and a CV build.
- **The monogram is its compact form.** `Monogram` is a brand-green triangle,
  point up and filling its tile, with a light-green A knocked out of its lower
  half. It has its own 16×16 tile (`MONOGRAM_TILE`) rather than the wordmark's
  24, because it must be crisp at 16px, where a 24-cell tile would put two thirds
  of a pixel in each cell. The triangle steps on the letters' slope; the A has
  1-cell strokes and three cells of green around it. Its two colours are fixed
  (`fill-brand`, `fill-brand-ink`), not `currentColor`, because it is the tab
  icon wherever it appears: the status strip and every inline loading indicator
  at 16px. The favicon and the installed-app icons are the monogram — the tab on
  a transparent ground, the home-screen icons centred on white.
- `size` is the height. `Mark` snaps it to a whole multiple of 24 (24, 48, 72),
  `Monogram` to a multiple of 16, so cells land on device pixels: 48 gives 104×48
  in the sidebar, 72 gives 156×72 on the sign-in panel, 24 gives 52×24 on the
  loading page.
- `searching` turns it, and that is the product's **only loading indicator**: a
  page loading (`loading.tsx`, the wordmark at 24), a CV building
  (`CvBuildProgress`, the wordmark at 48), a search or filter in flight
  (`SearchPending` inside a `SearchForm`), a description loading or a suggestion
  saving (the monogram at 16). Everywhere else — sidebar, sign-in, the status
  strip — the mark is still. A mark that is always turning tells the user
  nothing.
- Each letter turns about its own box: `ds-mark-letter` on the letter (a
  `<path>`, or for the two-layer monogram a `<g>`) sets `transform-box: fill-box`,
  and `ds-mark-turning` on the svg starts the letters a beat apart. The turn is
  about the vertical axis because the letters are kerned: rotated in the plane, a
  letter at 45 degrees reaches 14.1 cells from its centre and its neighbour's
  centre is only 14 away. A turn about the vertical axis only narrows each row
  towards the letter's own centre line, so turning letters never touch.
- Each letter is one `<path>` of horizontal runs per colour (`WORDMARK_PATHS`,
  `MONOGRAM_TRIANGLE_PATH`, `MONOGRAM_PATH`), not one element per cell, because
  every mark on a page is serialised into the payload of every navigation. Its
  offset is baked into the coordinates rather than set with a `transform`
  attribute, which the turn's CSS transform would replace.
- Clear space is half the mark's height.
- Regenerate assets with `pnpm exec tsx scripts/generate-brand-assets.ts`. It
  writes `mark.svg` (currentColor), `mark-green` and `mark-light` SVGs and PNGs
  at 24/48/96/192, `monogram.svg` and PNGs at 16–512, and `app-icon-192`,
  `app-icon-512` and `app-icon-maskable-512`.

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
| `Mark` / `Monogram` | The wordmark and its compact form. Above. |

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

The CV document palettes in `components/CvAppearance.tsx` and `lib/cv-pdf.ts`
are deliberately **not** part of this system. A CV is a document the user styles
for an employer, not app chrome, and it keeps its own colours.
