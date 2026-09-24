# AVA design system

Black ground, white ink, four status hues. Silkscreen for headings and labels,
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

Greys are for structure only — raised surfaces, muted text, faint borders, hard
shadows. The four status hues are used as full-opacity ink or outline, always
with text beside them. There are no tinted fills.

### Base

Black `#000000` · White `#ffffff` · `#111111` · `#1a1a1a` · `#2a2a2a` ·
`#444444` · `#666666` · `#888888` · `#bbbbbb` · `#dddddd` · `#f2f2f2`

### Semantic roles

Each is a custom property flipped wholesale by `[data-theme="light"]`, and a
Tailwind utility. Reach for the utility, not the raw grey.

| Role | Utility | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| Ground | `bg-bg` | `#000` | `#fff` | The page |
| Raised | `bg-raised` | `#111` | `#fff` | Cards, the status strip |
| Sunken | `bg-sunken` | `#1a1a1a` | `#f2f2f2` | Table heads, expanded rows, hover |
| Ink | `text-fg` | `#fff` | `#000` | Body |
| Muted | `text-muted` | `#888` | `#666` | Secondary text, table heads, ghost buttons |
| Faint | `text-faint` | `#444` | `#bbb` | Placeholders — the dimmest legible step |
| Line | `border-line` | `#fff` | `#000` | The structural 2px border |
| Line muted | `border-line-muted` | `#2a2a2a` | `#ddd` | Input borders, filter bars, dividers |
| Line faint | `border-line-faint` | `#1a1a1a` | `#f2f2f2` | Table row rules |
| Track | `bg-track` | `#2a2a2a` | `#ddd` | Unfilled fit cells, favicon fallbacks |
| Highlight | `bg-highlight` | `#1a1a1a` | `#f2f2f2` | The keyboard cursor row |
| Accent | `bg-accent` / `text-accent-fg` | `#fff` on `#000` | `#000` on `#fff` | Primary buttons, selected tabs |

`line` rather than `border`, so utilities read `border-2 border-line` instead of
`border-border`.

### Status

| Role | Utility | Dark | Light |
| --- | --- | --- | --- |
| OK | `ok` | `#4fd18b` | `#1a7f4b` |
| Warning | `warn` | `#f0b429` | `#9a6400` |
| Danger | `danger` | `#ff5c5c` | `#c62828` |
| Info | `info` | `#6fb3ff` | `#1f5fa8` |

The light values are separate because the dark hues are tuned for a black ground
and fail contrast on white.

### Light mode

`[data-theme="light"]` on `<html>` redefines the semantic names and nothing
else. No component branches on the theme.

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
`shadow-hard-3` (8px, the raised login card). `inset-shadow-cursor` is the 4px
rule down the left of the keyboard cursor row. `ds-divider` draws the dotted
rule: 2px dots on a 4px pitch.

Spacing runs on the 4px scale in whole multiples. Sidebar 192px, content padding
24px, card padding 16px, table cells 12×8, minimum hit target 44px.

---

## Motion

Stepped, never eased. `ease-step-2` and `ease-step-4`, at 120/240/480ms.
`--animate-mark-turn` turns the mark while something is loading: each letter
turns once about its own centre in eight 45° jumps on a 200ms beat, one beat
behind the letter before it, then all three rest upright together before the
2.4s cycle repeats. `prefers-reduced-motion` stops every animation.

---

## States

Hover inverts the fill (white on black ↔ black on white) or underlines. Press
collapses the shadow and shifts the control +2,+2 — that is the `ds-press`
utility, applied by `Button`. Focus is one 2px ring at 3px offset, set once in
`globals.css` for every control; **components must not set their own**, because a
Tailwind `focus-visible:outline-*` utility outranks that rule. Disabled is 40%
opacity.

---

## The mark

A V A in three pixel letters, each drawn on its own 16×16 cell tile with 2-cell
strokes. The letter box is columns 2–13 and rows 2–13 of its tile, so its centre
is the tile centre. Both letters are all diagonal: every stroke steps one cell
outward each two rows, from a two-cell point to a twelve-cell base, so the A is
an upside-down V with a bar two thirds of the way down and the V is that outline
turned over; neither has a vertical side. It is the only graphic in the product.
The glyph rows live in
`components/brand/mark-cells.ts` and are the single source: `Mark.tsx` and
`Monogram.tsx` render them on the page, and `scripts/generate-brand-assets.ts`
renders the favicon, the installed-app icons, the SVGs and the PNG sizes in
`public/brand/` from the same data, so the tab and the page can never drift.

- **The mark is the wordmark.** `Mark` sets the tiles side by side at x = 0, 16
  and 32 on a 48×16 grid: four empty cells between letters, two at each edge.
  There is no separate logotype.
- **The monogram is its compact form.** `Monogram` is the A tile alone, 16×16,
  for wherever the wordmark would be too wide: the status strip and every inline
  loading indicator at 16px. The favicon and the installed-app icons are the
  monogram, white on black.
- `size` is the height. Both snap it to a whole multiple of 16 (16, 32, 48, 64)
  so cells land on device pixels, and the wordmark is three times as wide as it
  is tall: 48 gives 144×48 in the sidebar, 64 gives 192×64 on the sign-in pages.
- `searching` turns it, and that is the product's **only loading indicator**: a
  page loading (`loading.tsx`, the wordmark at 32), a CV building
  (`CvBuildProgress`, the wordmark at 48), a search or filter in flight
  (`SearchPending` inside a `SearchForm`), a description loading or a suggestion
  saving (the monogram at 16). Everywhere else — sidebar, sign-in, the status
  strip — the mark is still. A mark that is always turning tells the user
  nothing.
- Each letter turns about its own box: `ds-mark-letter` on the `<path>` sets
  `transform-box: fill-box`, and `ds-mark-turning` on the svg starts the letters
  a beat apart. At pitch 16 turning neighbours never touch: a letter at 45
  degrees reaches 8.49 cells from its centre, its neighbour at most 6.
- Each letter is one `<path>` of horizontal runs (`WORDMARK_PATHS`,
  `MONOGRAM_PATH`), not one element per cell, because every mark on a page is
  serialised into the payload of every navigation. Its offset is baked into the
  coordinates rather than set with a `transform` attribute, which the turn's CSS
  transform would replace.
- Clear space is half the mark's height.
- Regenerate assets with `pnpm exec tsx scripts/generate-brand-assets.ts`.

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
| `Button` | Silkscreen uppercase. `primary` inverted ink with a 4px shadow, `secondary` raised with a full-contrast border, `danger` the danger hue, `ghost` muted text that underlines. `buttonClass()` for links and submit buttons that cannot be a `<Button>`. |
| `Card` | 2px border on `bg-raised`, pixel title bar, `raised` for the 8px shadow. |
| `Badge` | Outline and text in one tone; the tone helpers map app states to roles. `toneText` gives the same tone as ink alone, for secondary text under a badge. |
| `PageHeader` | Silkscreen 20px title over a 2px rule. |
| `EmptyState` | Dashed 2px border, pixel title. |
| `table.tsx` | `Table`/`THead`/`TBody`/`TR`/`TH`/`TD` plus `FitBar`, the ten stepped cells. `TR highlighted` is the keyboard cursor. |
| `Field` | `Field`/`Input`/`Textarea`/`Select`/`Checkbox`, and the `inputClass`, `selectClass` and `labelClass` strings for server components that style raw inputs. |
| `NavLink` / `WorkspaceNav` | Sidebar items invert when active; workspace links underline over a dotted rule. |
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
way to the AVA wordmark when the product was renamed.

The CV document palettes in `components/CvAppearance.tsx` and `lib/cv-pdf.ts`
are deliberately **not** part of this system. A CV is a document the user styles
for an employer, not app chrome, and it keeps its own colours.
