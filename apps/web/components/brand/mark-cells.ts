/**
 * The AVA mark: three pixel letters, A V A, each drawn on its own 16×16 cell tile with 2-cell
 * strokes. Rows run top to bottom, `#` filled; the letter box is columns 2–13 and rows 2–13, so
 * its centre is the tile centre and a letter turns about the middle of its own tile.
 *
 * Both letters are all diagonal: each stroke steps one cell outward every two rows from a
 * two-cell point to a twelve-cell base, so the A is an upside-down V with a bar two thirds of
 * the way down, and the V is the A's outline turned over. Neither has a vertical side.
 *
 * This is the single source for the artwork. `Mark.tsx` and `Monogram.tsx` render it in the app
 * and `scripts/generate-brand-assets.ts` renders the favicons and PNGs from it, so the tab icon and
 * the mark on the page can never drift apart.
 */
export const GLYPH_A = [
  "................",
  "................",
  ".......##.......",
  ".......##.......",
  "......####......",
  "......####......",
  ".....##..##.....",
  ".....##..##.....",
  "....##....##....",
  "....##....##....",
  "...##########...",
  "...##########...",
  "..##........##..",
  "..##........##..",
  "................",
  "................",
] as const;

export const GLYPH_V = [
  "................",
  "................",
  "..##........##..",
  "..##........##..",
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
/** Tiles sit side by side: four empty cells between letters, two at each edge. */
export const PITCH = TILE;
/** The wordmark's width in cells: three tiles at pitch 16. */
export const WORDMARK_WIDTH = 2 * PITCH + TILE;

/** The wordmark's letters, each with the column its tile starts at: A at 0, V at 16, A at 32. */
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
