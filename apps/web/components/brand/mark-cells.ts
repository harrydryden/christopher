/**
 * The Course of Life mark and wordmark, as cell rows. Rows run top to bottom, `#` filled.
 *
 * The mark is a C-shaped path and a point: the wordmark's own C, drawn on a 24-cell tile with
 * 2-cell strokes and its corners cut by one stroke, with a 4-cell point sitting at its opening on
 * the baseline, where the path leads. (A point at the C's centre reads as a copyright sign, which
 * is why it sits at the opening.) The small mark is the same artwork on a 16-cell tile, because it
 * has to be crisp at 16px (the favicon and every inline indicator) where a 24-cell tile would put
 * two thirds of a pixel in each cell.
 *
 * The wordmark is the domain, stacked: `COURSE` over `OF.LIFE`, in 5-by-7 pixel capitals with
 * 1-cell strokes, both lines justified to one measure of 50 cells so they form a rectangle. The
 * first line's six letters are tracked 4 cells apart, the second line's seven slots 3 apart; the
 * dot is a 2-cell square on the baseline and takes a slot of its own. Two empty rows separate the
 * lines, so the wordmark is 16 cells tall and renders at whole multiples of 16 (32, 48, 64, 80,
 * 96) with cells on device pixels.
 *
 * This is the single source for the artwork. `Mark.tsx`, `MarkSmall.tsx` and `Wordmark.tsx`
 * render it on the page and `scripts/generate-brand-assets.ts` renders the favicon, the installed-
 * app icons and the SVGs and PNGs in `public/brand/` from the same data, so the tab and the page
 * can never drift apart.
 */

/** The mark on its 24-cell tile. */
export const MARK_TILE = 24;

export const GLYPH_MARK = [
  "........................",
  "........................",
  "........................",
  "......############......",
  "......############......",
  "....##............##....",
  "....##............##....",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "..##....................",
  "....##..............####",
  "....##..............####",
  "......############..####",
  "......############..####",
  "........................",
  "........................",
  "........................",
] as const;

/** The small mark's own tile: 16 cells, so it lands on whole device pixels at 16, 32 and 48. */
export const MARK_SMALL_TILE = 16;

export const GLYPH_MARK_SMALL = [
  "................",
  "................",
  "....########....",
  "....########....",
  "..##........##..",
  "..##........##..",
  ".##.............",
  ".##.............",
  ".##.............",
  ".##.............",
  ".##.............",
  "..##............",
  "..##.........###",
  "....########.###",
  "....########.###",
  "................",
] as const;

/** A wordmark glyph: its rows on the 7-row line. Every row of a glyph is the same width. */
export type GlyphRows = readonly string[];

/** The capitals the wordmark needs, 5 by 7, and the dot: a 2-cell square on the baseline. */
export const WORDMARK_LETTERS: Readonly<Record<string, GlyphRows>> = {
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  ".": ["..", "..", "..", "..", "..", "##", "##"],
};

/** The wordmark's two lines: the text, the cells between glyphs, and the row the line starts on. */
export const WORDMARK_LINES = [
  { text: "COURSE", gap: 4, y: 0 },
  { text: "OF.LIFE", gap: 3, y: 9 },
] as const;

/** The wordmark's height in cells: two 7-row lines with two empty rows between them. */
export const WORDMARK_TILE = 16;

/** A glyph placed in the wordmark: its rows and the column and row its top-left cell sits at. */
export interface PlacedGlyph {
  rows: GlyphRows;
  dx: number;
  dy: number;
}

/** Place each line's glyphs left to right, `gap` cells apart. */
function placeGlyphs(): PlacedGlyph[] {
  return WORDMARK_LINES.flatMap((line) => {
    let x = 0;
    return [...line.text].map((ch) => {
      const rows = WORDMARK_LETTERS[ch]!;
      const placed = { rows, dx: x, dy: line.y };
      x += rows[0]!.length + line.gap;
      return placed;
    });
  });
}

/**
 * Every glyph of the wordmark, in reading order, with where it sits.
 *
 * The derived exports below are marked pure so a bundle keeps only the artwork it draws: every
 * page's client bundle carries the wordmark and the small mark, and the 24-cell mark, drawn only
 * on the server-rendered sign-in panel, drops out. The artwork's invariants (square tiles, glyphs
 * of 7 rows, both wordmark lines on one measure) are checked in `mark-cells.test.ts` rather than
 * here, so the checks cost the browser nothing.
 */
export const WORDMARK_GLYPHS: readonly PlacedGlyph[] = /*#__PURE__*/ placeGlyphs();

/** The wordmark's width in cells: 50. Both lines share it; the test holds them to that. */
export const WORDMARK_WIDTH = 50;

/** A filled cell, in tile coordinates. */
export interface Cell {
  x: number;
  y: number;
}

/**
 * The filled cells of a glyph, in the order the blank pixel redraws them: columns left to right,
 * each column top to bottom, so the pixel runs through a letter the way a plotter would.
 */
export function cellsOf(rows: GlyphRows, dx = 0, dy = 0): Cell[] {
  const cells: Cell[] = [];
  const width = rows[0]!.length;
  for (let x = 0; x < width; x++) {
    rows.forEach((row, y) => {
      if (row[x] === "#") cells.push({ x: x + dx, y: y + dy });
    });
  }
  return cells;
}

/**
 * One SVG path of horizontal runs for a set of rows, offset by `dx`,`dy`. One path per artwork
 * rather than a rect per cell, because every mark on a page is serialised into the payload of
 * every navigation. The offset is baked into the coordinates rather than set with a `transform`.
 */
export function pathOf(glyphs: readonly PlacedGlyph[]): string {
  const runs: string[] = [];
  for (const { rows, dx, dy } of glyphs) {
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== "#") {
          x++;
          continue;
        }
        let end = x;
        while (end < row.length && row[end] === "#") end++;
        runs.push(`M${x + dx} ${y + dy}h${end - x}v1H${x + dx}z`);
        x = end;
      }
    });
  }
  return runs.join("");
}

/** The cells of every placed glyph, in reading order, each glyph in plotter order. */
function wordmarkCells(): Cell[] {
  return WORDMARK_GLYPHS.flatMap((g) => cellsOf(g.rows, g.dx, g.dy));
}

export const MARK_PATH = /*#__PURE__*/ pathOf([{ rows: GLYPH_MARK, dx: 0, dy: 0 }]);
export const MARK_SMALL_PATH = /*#__PURE__*/ pathOf([{ rows: GLYPH_MARK_SMALL, dx: 0, dy: 0 }]);
export const WORDMARK_PATH = /*#__PURE__*/ pathOf(WORDMARK_GLYPHS);

/** The cells the blank pixel passes through while something loads, in order. */
export const MARK_CELLS: readonly Cell[] = /*#__PURE__*/ cellsOf(GLYPH_MARK);
export const MARK_SMALL_CELLS: readonly Cell[] = /*#__PURE__*/ cellsOf(GLYPH_MARK_SMALL);
export const WORDMARK_CELLS: readonly Cell[] = /*#__PURE__*/ wordmarkCells();
