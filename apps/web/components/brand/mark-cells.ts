/**
 * The AVA mark, as cell rows. Rows run top to bottom, `#` filled.
 *
 * The wordmark is three pixel letters, A V A, each drawn on its own 24×24 cell tile with 3-cell
 * strokes. The letter box is columns 2–21 and rows 2–21, so its centre is the tile centre.
 *
 * Both letters are all diagonal: each stroke steps one cell outward every two rows from a
 * two-cell point to a twenty-cell base, so the A is an upside-down V with a 3-row bar two thirds
 * of the way down, and the V is the A's outline turned over. Neither has a vertical side.
 *
 * The monogram is drawn on its own 16×16 tile, because it has to be crisp at 16px (the favicon
 * and the status strip) where a 24-cell tile would put two thirds of a pixel in each cell. It is
 * a triangle filling the tile, stepping outward on the same one-cell-per-two-rows slope as the
 * letters, with a 1-cell-stroke A knocked out of its lower half.
 *
 * This is the single source for the artwork. `Mark.tsx` and `Monogram.tsx` render it in the app
 * and `scripts/generate-brand-assets.ts` renders the favicons and PNGs from it, so the tab icon and
 * the mark on the page can never drift apart.
 */
export const GLYPH_A = [
  "........................",
  "........................",
  "...........##...........",
  "...........##...........",
  "..........####..........",
  "..........####..........",
  ".........######.........",
  ".........######.........",
  "........###..###........",
  "........###..###........",
  ".......###....###.......",
  ".......###....###.......",
  "......###......###......",
  "......###......###......",
  ".....###........###.....",
  ".....##############.....",
  "....################....",
  "....################....",
  "...###............###...",
  "...###............###...",
  "..###..............###..",
  "..###..............###..",
  "........................",
  "........................",
] as const;

export const GLYPH_V = [
  "........................",
  "........................",
  "..###..............###..",
  "..###..............###..",
  "...###............###...",
  "...###............###...",
  "....###..........###....",
  "....###..........###....",
  ".....###........###.....",
  ".....###........###.....",
  "......###......###......",
  "......###......###......",
  ".......###....###.......",
  ".......###....###.......",
  "........###..###........",
  "........###..###........",
  ".........######.........",
  ".........######.........",
  "..........####..........",
  "..........####..........",
  "...........##...........",
  "...........##...........",
  "........................",
  "........................",
] as const;

/** Every wordmark letter sits on a 24-cell tile, and the wordmark renders at whole multiples of it. */
export const TILE = 24;
/**
 * Letters are kerned: tiles start 14 cells apart, so their boxes overlap and the A's right leg
 * runs parallel to the V's left one with three empty cells between them, one stroke's width of
 * air all the way down. Two empty cells remain at each edge.
 */
export const PITCH = 14;
/** The wordmark's width in cells: three tiles at pitch 14. */
export const WORDMARK_WIDTH = 2 * PITCH + TILE;

/** The wordmark's letters, each with the column its tile starts at: A at 0, V at 14, A at 28. */
export const WORDMARK_GLYPHS = [
  { rows: GLYPH_A, dx: 0 },
  { rows: GLYPH_V, dx: PITCH },
  { rows: GLYPH_A, dx: 2 * PITCH },
] as const;

/** The monogram's own tile: 16 cells, so it lands on whole device pixels at 16, 32 and 48. */
export const MONOGRAM_TILE = 16;

/** The monogram's A, drawn in the light brand green inside the triangle. */
export const GLYPH_MONOGRAM_A = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".......##.......",
  ".......##.......",
  "......#..#......",
  "......#..#......",
  ".....#....#.....",
  ".....######.....",
  "....#......#....",
  "....#......#....",
  "................",
  "................",
] as const;

/** The monogram's triangle, point up and filling the tile, drawn in the brand green. */
export const GLYPH_TRIANGLE = [
  ".......##.......",
  ".......##.......",
  "......####......",
  "......####......",
  ".....######.....",
  ".....######.....",
  "....########....",
  "....########....",
  "...##########...",
  "...##########...",
  "..############..",
  "..############..",
  ".##############.",
  ".##############.",
  "################",
  "################",
] as const;

/** The triangle with the A's cells knocked out, so either layer alone still reads as the monogram. */
const TRIANGLE_KNOCKOUT = GLYPH_TRIANGLE.map((row, y) =>
  [...row].map((cell, x) => (GLYPH_MONOGRAM_A[y]![x] === "#" ? "." : cell)).join(""),
);

/**
 * One layer as one SVG path, offset `dx` cells: horizontal runs of filled cells become
 * rectangles, so a letter is a few hundred bytes rather than one element per cell. That matters
 * because every mark on a page is serialised into the RSC payload of every navigation.
 *
 * The offset is baked into the coordinates rather than given as a `transform` attribute, because
 * the turning animation sets a CSS transform on the letter, which would replace it.
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

/** The monogram's A, the light layer. */
export const MONOGRAM_PATH = pathOf(GLYPH_MONOGRAM_A);
/** The monogram's triangle with the A knocked out, the dark layer. */
export const MONOGRAM_TRIANGLE_PATH = pathOf(TRIANGLE_KNOCKOUT);

/** The wordmark, one path per letter so that each can turn on its own. */
export const WORDMARK_PATHS: readonly [string, string, string] =
  WORDMARK_GLYPHS.map(({ rows, dx }) => pathOf(rows, dx)) as [string, string, string];
