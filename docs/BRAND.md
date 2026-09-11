# Christopher brand

The mark is four Bombe drums on steel bars — the machine Turing's team called
Christopher. Designed in Claude Design; the source prototype and the full chat
history live in the handoff bundle, not in this repo.

## Components

`@/components/brand` exports three server components. None of them ships
JavaScript to the client, and none needs a webfont.

| Component | Use |
| --- | --- |
| `ChristopherMark` | The four-drum block on its own. `searching` turns the drums. |
| `ChristopherWordmark` | "Christopher" in Spectral Medium, pre-outlined. |
| `ChristopherLockup` | Mark + wordmark at the ratios below. |

```tsx
import { ChristopherLockup, ChristopherMark } from "@/components/brand";

<ChristopherLockup markSize={64} color="var(--brand-ink)" id="hero" />
<ChristopherMark size={40} searching id="scanning" />
```

`id` namespaces the SVG gradient ids. SVG ids are document-global, so **give
every mark on a page a distinct `id`** or their gradients collide.

`lockupWidth(markSize)` and `wordmarkWidth(capHeight)` return the px width each
will occupy, for fitting a lockup into a fixed column.

## Where it is used

- Sidebar (`app/(app)/layout.tsx`) — horizontal lockup, `markSize={32}`.
- Login (`app/login/page.tsx`) — horizontal lockup, `markSize={64}`.
- Route loading (`app/(app)/loading.tsx`) — mark with `searching`.
- Tab, home screen and installed icons — `app/favicon.ico`, `app/icon.svg`,
  `app/apple-icon.png`, `app/manifest.ts`.

## Mark variants

| Variant | Size | File |
| --- | --- | --- |
| Full | >= 160px | `public/brand/christopher-logo-mark.svg` |
| Compact | >= 160px, bars stop at the wheel edge | `...-compact.svg` |
| Simplified | 40-160px — what the components render | `...-simplified.svg` |
| Monochrome | print, embossing, co-branding | `...-mono-ink.svg` / `-mono-paper.svg` |
| Favicon | single Slate drum; detailed >= 64, flat <= 48 | `christopher-favicon.svg` / `-flat.svg` |

## Rules

**Clear space.** Half a wheel diameter on every side; a full wheel for the
extended-bar version.

**Lockup.** Wordmark cap height = one wheel diameter. Gap = 1/3 of the mark
width. Do not stack the mark above the wordmark below 200px wide.

**Colours.** Rust `#9a3f30` · Brass `#b8862f` · Verdigris `#3c6a5c` ·
Slate `#2f5678` · Ink `#151e25` · Paper `#f4f1ea` · Bakelite `#3a2419` ·
Steel `#a9b3bb`. Declared as `--brand-*` in `app/globals.css`.

Slate is the designated product accent and is what the manifest and
`theme-color` use. Brass is decorative only — it fails text contrast on Paper.

**Motion.** The drums turn at 2.6-4s per revolution, alternating direction, and
settle to their resting angles when results arrive. `prefers-reduced-motion`
stops them (`app/globals.css`).

## Known deviations

- **Sidebar mark is 32px, below the 40px floor for the simplified build.** At
  BRAND.md's lockup ratios a 192px sidebar (`md:w-48`, 12px padding) fits at
  most a 32px mark: `32 + 32/3 + 123 = 166px` of 168px available. Widening the
  sidebar to `md:w-56` would allow a compliant 40px mark.
- **App chrome still runs on `--app-navy` (`#142D46`), not Slate (`#2f5678`).**
  BRAND.md wants the product accent to match the favicon so tab and UI read as
  one brand. Changing it restyles the sidebar, scan banner, page headers and
  focus rings, so it was left as a deliberate decision rather than a side
  effect of adding the logo.

## Regenerating the artwork

`components/brand/artwork.ts` is generated, not hand-written. The wheel shapes
and gradients are lifted verbatim from artboard 4a of the design prototype; the
wordmark is Spectral Medium at -1.5% tracking, converted to outlines.

Two things to know if you ever regenerate it:

- **Outlines, not `font-family`.** The original exports set
  `font-family="Spectral, Georgia, serif"` on 104 `<text>` elements in the mark
  and 105 in each lockup. Anywhere Spectral was not installed, the drum letter
  band and the wordmark silently fell back to Georgia — which is what the
  original 2400px lockup PNGs were baked with. Everything here is outlined, so
  there is no font to miss.
- **`Path#toPathData()` in opentype.js 2.0.0 emits `NaN`.** It does this for
  some inputs even when every command value is finite, and the result depends
  on the origin and font size you happened to pass. An SVG path parser stops at
  the first `NaN`, which truncates the word without any error — "Christopher"
  renders as "Christ". Serialise the path commands yourself and assert the
  output contains no `NaN` before writing it.
