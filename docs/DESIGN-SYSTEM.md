# Christopher design system

One accent, one neutral ramp, four status colours, two type sizes. The UI is a
dense keyboard-first table app, so the system is deliberately small — if you
find yourself reaching for a colour or a size that is not here, that is a
signal to reuse something, not to add a token.

Tokens live in `@theme` in `apps/web/app/globals.css`. Tailwind turns each one
into a utility, so `--color-accent` gives you `bg-accent`, `text-accent`,
`border-accent`, `ring-accent` and `outline-accent`. **Prefer the semantic name
over a raw palette shade.**

---

## Colour

### Roles

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Accent | `accent` | `#142D46` | App chrome, primary buttons, links, focus rings, `accent-color` |
| Accent hover | `accent-hover` | `#2f5678` | Hover step on accent-filled controls |
| Accent tint | `accent-tint` | `#eef1f6` | Selected rows, highlighted cells, informational badges |
| Track | `track` | `#e5eaf0` | Progress and meter rails |
| Neutral | `slate-*` | Tailwind | Text, borders, surfaces — the only neutral ramp |
| Danger | `red-*` | Tailwind | Destructive actions, errors |
| Warning | `amber-*` | Tailwind | Setup required, degraded state |
| Success | `emerald-*` | Tailwind | Healthy, applied, confirmed |

Neutrals are `slate` only. Do not use `gray`, `zinc`, `neutral` or `stone` —
mixing neutral ramps is visible as a faint colour-temperature shift between
adjacent surfaces.

### Accent, and why there is only one

The accent is the deep navy `#142D46` set in #30. It carries the chrome *and*
every interactive state. Its hover step is brand Slate `#2f5678`, so the ramp
stays inside the brand palette rather than drifting to another hue.

Brand Slate also remains the tab and installed-app colour (`app/manifest.ts`,
`viewport.themeColor`) because it reads better than the deep navy at favicon
size. That is the one deliberate place where tab and chrome differ.

### Brand palette

The four enamel drum colours from the mark, plus its neutrals. Available as
`brand-rust`, `brand-brass`, `brand-verdigris`, `brand-slate`, `brand-ink`,
`brand-paper`, `brand-bakelite`, `brand-steel`.

Rust `#9a3f30` · Brass `#b8862f` · Verdigris `#3c6a5c` · Slate `#2f5678` ·
Ink `#151e25` · Paper `#f4f1ea` · Bakelite `#3a2419` · Steel `#a9b3bb`

These belong to the mark. Do not recruit them as UI colours — **Brass in
particular fails text contrast on Paper** and is decorative only.

---

## Typography

System sans (`ui-sans-serif`), with `font-variant-numeric: tabular-nums` on
`body` so figures line up in tables. The wordmark is the only place Spectral
appears, and it is pre-outlined, so the app loads no webfont at all.

| Size | Use | Share |
| --- | --- | --- |
| `text-sm` | Body, controls, table cells — the default | ~65% |
| `text-xs` | Secondary text, badges, dense cells | ~30% |
| `text-lg` | Section headings | rare |
| `1.5rem` | Page title, via `[data-page-header] h1` | one rule |

Two weights: `font-medium` for controls and emphasis, `font-semibold` for
headings. Muted text is `text-slate-500`; body is `text-slate-900`.

## Shape and spacing

`rounded` (4px) for dense in-table controls, `rounded-md` (6px) for buttons and
inputs, `rounded-lg` (8px) for cards and panels, `rounded-full` for pills and
meters. Padding runs on the Tailwind 4px scale; cards are `p-4`, page headers
`1.5rem`, the main column `p-4 md:p-6`.

---

## Components

All in `apps/web/components`. Compose these rather than restyling a `<div>`.

| Component | Notes |
| --- | --- |
| `Button` | `primary` / `secondary` / `danger` / `ghost`, sizes `sm` / `md`. `buttonClass()` exports the same classes for `<a>` and `<form>` submits. |
| `Card` | Bordered white panel with optional title and actions. |
| `Badge` | Status pill. Tones map to the roles above. |
| `PageHeader` | Navy banner; sets `[data-page-header]`, which restyles its own `h1`, description and buttons. |
| `EmptyState` | Zero-state copy and call to action. |
| `table.tsx` | Table primitives; highlighted rows use `bg-accent-tint`. |
| `NavLink` / `WorkspaceNav` | Sidebar and section navigation, with `aria-current`. |
| `brand/` | Mark, wordmark and lockup — see below. |

### Focus

`globals.css` gives every `input`, `select`, `textarea`, `button` and `a` the
same 2px accent outline at a 3px offset; inside navy chrome it flips to white.

**Components must not set their own focus colour.** A Tailwind
`focus-visible:outline-*` utility has higher specificity than that rule, so a
component that sets its own silently desynchronises from the rest of the app —
which is exactly how buttons ended up focusing indigo while every other control
focused navy.

---

## Brand

The mark is four Bombe drums on steel bars — the machine Turing's team called
Christopher. Designed in Claude Design; the prototype and chat history live in
the handoff bundle, not in this repo.

### Components

`@/components/brand` exports three server components. None ships client
JavaScript, and none needs a webfont.

| Component | Use |
| --- | --- |
| `ChristopherMark` | The four-drum block. `searching` turns the drums. |
| `ChristopherWordmark` | "Christopher" in Spectral Medium, pre-outlined. |
| `ChristopherLockup` | Mark + wordmark at the ratios below. |

```tsx
import { ChristopherLockup, ChristopherMark } from "@/components/brand";

<ChristopherLockup markSize={64} color="var(--color-brand-ink)" id="hero" />
<ChristopherMark size={40} searching id="scanning" />
```

`id` namespaces the SVG gradient ids. SVG ids are document-global, so **give
every mark on a page a distinct `id`** or their gradients collide.

`lockupWidth(markSize)` and `wordmarkWidth(capHeight)` return the px width each
will occupy, for fitting a lockup into a fixed column.

### Where it appears

- Sidebar (`app/(app)/layout.tsx`) — horizontal lockup, `markSize={32}`.
- Login (`app/login/page.tsx`) — horizontal lockup, `markSize={64}`.
- Route loading (`app/(app)/loading.tsx`) — mark with `searching`.
- Tab, home screen and installed icons — `app/favicon.ico`, `app/icon.svg`,
  `app/apple-icon.png`, `app/manifest.ts`.

### Variants

| Variant | Size | File |
| --- | --- | --- |
| Full | >= 160px | `public/brand/christopher-logo-mark.svg` |
| Compact | >= 160px, bars stop at the wheel edge | `...-compact.svg` |
| Simplified | 40-160px — what the components render | `...-simplified.svg` |
| Monochrome | print, embossing, co-branding | `...-mono-ink.svg` / `-mono-paper.svg` |
| Favicon | single Slate drum; detailed >= 64, flat <= 48 | `christopher-favicon.svg` / `-flat.svg` |

### Rules

**Clear space.** Half a wheel diameter on every side; a full wheel for the
extended-bar version.

**Lockup.** Wordmark cap height = one wheel diameter. Gap = 1/3 of the mark
width. Do not stack the mark above the wordmark below 200px wide.

**Motion.** The drums turn at 2.6-4s per revolution, alternating direction, and
settle to their resting angles when results arrive. `prefers-reduced-motion`
stops them.

---

## Accessibility

- One focus ring, always visible, never removed. `outline-none` on an input is
  only acceptable when a `focus:border-accent` + `focus:ring-accent` pair
  replaces it, which is the established input pattern.
- Colour is never the only signal. Links are underlined; badges carry text;
  the scan banner states its status in words.
- `prefers-reduced-motion` stops the drums. Any animation added later must
  honour it too.
- Accent on white is 14.2:1; `text-slate-500` on white is 4.8:1. Brass is not
  for text.

---

## Known deviations

- **Sidebar mark is 32px, below the 40px floor for the simplified build.** At
  the lockup ratios above, a 192px sidebar (`md:w-48`, 12px padding) fits at
  most a 32px mark: `32 + 32/3 + 123 = 166px` of 168px available. Widening to
  `md:w-56` would allow a compliant 40px mark.
- **`rounded` and `rounded-md` are both used heavily** for similar controls.
  The table above states the intent; existing call sites were not churned to
  match.
- **`Badge` keeps both `gray` and `neutral` tones.** They render the same muted
  slate. `gray` predates `neutral`; prefer `neutral` in new code.

---

## Regenerating the brand artwork

`components/brand/artwork.ts` is generated, not hand-written. The wheel shapes
and gradients are lifted verbatim from artboard 4a of the design prototype —
byte-for-byte identical to the `sm-*` symbols in the source file. The wordmark
is Spectral Medium at -1.5% tracking, converted to outlines.

Two things to know if you regenerate it:

- **Outlines, not `font-family`.** The original exports set
  `font-family="Spectral, Georgia, serif"` on 104 `<text>` elements in the mark
  and 105 in each lockup. Anywhere Spectral was not installed, the drum letter
  band and the wordmark silently fell back to Georgia — which is what the
  original 2400px lockup PNGs were baked with. Everything here is outlined, so
  there is no font to miss.
- **`Path#toPathData()` in opentype.js 2.0.0 emits `NaN`.** It does this for
  some inputs even when every path command value is finite, and whether it
  happens depends on the origin and font size passed. An SVG path parser stops
  at the first `NaN`, which truncates the word with no error — "Christopher"
  renders as "Christ". Serialise the path commands yourself and assert the
  output contains no `NaN` before writing it.
