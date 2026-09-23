/**
 * The AVA mark: three pixel letters, A V A, each drawn on its own 16×16 cell tile with 2-cell
 * strokes. Rows run top to bottom, `#` filled; the letter box is columns 3–12 and rows 2–13, so
 * its centre is the tile centre and a letter turns about the middle of its own tile.
 *
 * This is the single source for the artwork. `Mark.tsx` and `Monogram.tsx` render it in the app
 * and `scripts/generate-brand-assets.ts` renders the favicons and PNGs from it, so the tab icon and
 * the mark on the page can never drift apart.
 */
export const GLYPH_A = [
  "................",
  "................",
  ".......##.......",
  "......####......",
  ".....##..##.....",
  ".....##..##.....",
  "....##....##....",
  "....##....##....",
  "...##########...",
  "...##########...",
  "...##......##...",
  "...##......##...",
  "...##......##...",
  "...##......##...",
  "................",
  "................",
] as const;

export const GLYPH_V = [
  "................",
  "................",
  "...##......##...",
  "...##......##...",
  "...##......##...",
  "...##......##...",
  "....##....##....",
  "....##....##....",
  ".....##..##.....",
  ".....##..##.....",
  "......####......",
  "......####......",
  ".......##.......",
  ".......##.......",
  "................",
  "................",
] as const;

/** Every letter sits on a 16-cell tile, and the mark renders at whole multiples of it. */
export const TILE = 16;
/** Tiles overlap by two empty columns: four empty cells between letters, three at each edge. */
export const PITCH = 14;
/** The wordmark's width in cells: three tiles at pitch 14. */
export const WORDMARK_WIDTH = 2 * PITCH + TILE;

/** The wordmark's letters, each with the column its tile starts at: A at 0, V at 14, A at 28. */
export const WORDMARK_GLYPHS = [
  { rows: GLYPH_A, dx: 0 },
  { rows: GLYPH_V, dx: PITCH },
  { rows: GLYPH_A, dx: 2 * PITCH },
] as const;

/**
 * One letter as one SVG path, offset `dx` cells: horizontal runs of filled cells become
 * rectangles, so a letter is a few hundred bytes rather than 60 elements. That matters because
 * every mark on a page is serialised into the RSC payload of every navigation.
 *
 * The offset is baked into the coordinates rather than given as a `transform` attribute, because
 * the turning animation sets a CSS transform on the path, which would replace it.
 */
export function pathOf(rows: readonly string[], dx = 0): string {
  const runs: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") { x++; continue; }
      const start = x;
      while (row[x] === "#") x++;
      runs.push(`M${start + dx} ${y}h${x - start}v1H${start + dx}z`);
    }
  });
  return runs.join("");
}

/** The compact form: the A tile alone. */
export const MONOGRAM_PATH = pathOf(GLYPH_A);

/** The wordmark, one path per letter so that each can turn on its own. */
export const WORDMARK_PATHS: readonly [string, string, string] =
  WORDMARK_GLYPHS.map(({ rows, dx }) => pathOf(rows, dx)) as [string, string, string];
