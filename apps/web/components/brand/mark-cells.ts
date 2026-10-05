/**
 * The Course of Life mark and wordmark, as cell rows. Rows run top to bottom, `#` filled.
 *
 * The mark is a point with three arched paths leaving it: a fork in the road. It is drawn on a
 * 24-cell tile with 2-cell strokes: a 4-cell point at the centre, one path straight up, and two
 * that leave the point's lower corners heading outward and steepen to vertical, so the three
 * meet the tile's edge at the top and the bottom. The top path is straight so the mark stays
 * mirror-symmetric, which a square grid can render exactly; the two below it arch.
 *
 * The small mark is the same artwork on a 16-cell tile, because it has to be crisp at 16px (the
 * favicon and every inline indicator) where a 24-cell tile would put two thirds of a pixel in
 * each cell.
 *
 * The wordmark is the domain, stacked: `course` over `of.life`, lowercase, both lines 29 cells
 * wide so they form a rectangle. Glyphs sit on a 7-row line (rows 0–1 ascender, 2–6 x-height)
 * with 1-cell strokes; the first line's glyphs are 4 cells wide with 1 cell between them, the
 * second line's are narrower (f 3, the dot, l and i 1) with 2 cells between them, which is what
 * brings it to the same measure. Two empty rows separate the lines, so the wordmark is 16 cells
 * tall and renders at whole multiples of 16 (32, 48, 64, 80, 96) with cells on device pixels.
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
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "...........##...........",
  "..........####..........",
  "..........####..........",
  "..........####..........",
  "..........####..........",
  "........##....##........",
  "......###......###......",
  ".....##..........##.....",
  "....##............##....",
  "...##..............##...",
  "...##..............##...",
  "..##................##..",
  "..##................##..",
  "........................",
  "........................",
] as const;

/** The small mark's own tile: 16 cells, so it lands on whole device pixels at 16, 32 and 48. */
export const MARK_SMALL_TILE = 16;

export const GLYPH_MARK_SMALL = [
  "................",
  ".......##.......",
  ".......##.......",
  ".......##.......",
  ".......##.......",
  ".......##.......",
  "......####......",
  "......####......",
  "......####......",
  "......####......",
  "....##....##....",
  "...##......##...",
  "..##........##..",
  ".##..........##.",
  ".##..........##.",
  "................",
] as const;

/** A wordmark glyph: its rows on the 7-row line. Widths vary; every row of a glyph is the same width. */
export type GlyphRows = readonly string[];

/** The lowercase glyphs the wordmark needs. Rows 0–1 are the ascender, rows 2–6 the x-height. */
export const WORDMARK_LETTERS: Readonly<Record<string, GlyphRows>> = {
  c: ["....", "....", ".###", "#...", "#...", "#...", ".###"],
  o: ["....", "....", ".##.", "#..#", "#..#", "#..#", ".##."],
  u: ["....", "....", "#..#", "#..#", "#..#", "#..#", ".###"],
  r: ["....", "....", "#.##", "##..", "#...", "#...", "#..."],
  s: ["....", "....", ".###", "#...", ".##.", "...#", "###."],
  e: ["....", "....", ".##.", "#..#", "####", "#...", ".###"],
  f: [".##", "#..", "###", "#..", "#..", "#..", "#.."],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  l: ["#", "#", "#", "#", "#", "#", "#"],
  i: ["#", ".", "#", "#", "#", "#", "#"],
};

/** The wordmark's two lines: the text, the cells between glyphs, and the row the line starts on. */
export const WORDMARK_LINES = [
  { text: "course", gap: 1, y: 0 },
  { text: "of.life", gap: 2, y: 9 },
] as const;

/** The wordmark's height in cells: two 7-row lines with two empty rows between them. */
export const WORDMARK_TILE = 16;

/** A glyph placed in the wordmark: its rows and the column and row its top-left cell sits at. */
export interface PlacedGlyph {
  rows: GlyphRows;
  dx: number;
  dy: number;
}

/** Every glyph of the wordmark, in reading order, with where it sits. */
export const WORDMARK_GLYPHS: readonly PlacedGlyph[] = WORDMARK_LINES.flatMap((line) => {
  let x = 0;
  return [...line.text].map((ch) => {
    const rows = WORDMARK_LETTERS[ch];
    if (!rows) throw new Error(`no wordmark glyph for "${ch}"`);
    const placed = { rows, dx: x, dy: line.y };
    x += rows[0]!.length + line.gap;
    return placed;
  });
});

/** The measure of each line, which must agree: that is what makes the stack a rectangle. */
const LINE_WIDTHS = WORDMARK_LINES.map((line) =>
  [...line.text].reduce((w, ch) => w + WORDMARK_LETTERS[ch]![0]!.length, 0) + (line.text.length - 1) * line.gap,
);
if (new Set(LINE_WIDTHS).size !== 1) throw new Error(`wordmark lines differ in width: ${LINE_WIDTHS.join(", ")}`);

/** The wordmark's width in cells: 29. */
export const WORDMARK_WIDTH = LINE_WIDTHS[0]!;

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

for (const [rows, tile] of [[GLYPH_MARK, MARK_TILE], [GLYPH_MARK_SMALL, MARK_SMALL_TILE]] as const) {
  if (rows.length !== tile || rows.some((row) => row.length !== tile)) throw new Error(`the mark must be ${tile}×${tile}`);
}
for (const [ch, rows] of Object.entries(WORDMARK_LETTERS)) {
  if (rows.length !== 7 || rows.some((row) => row.length !== rows[0]!.length)) throw new Error(`glyph "${ch}" is not 7 rows of one width`);
}

export const MARK_PATH = pathOf([{ rows: GLYPH_MARK, dx: 0, dy: 0 }]);
export const MARK_SMALL_PATH = pathOf([{ rows: GLYPH_MARK_SMALL, dx: 0, dy: 0 }]);
export const WORDMARK_PATH = pathOf(WORDMARK_GLYPHS);

/** The cells the blank pixel passes through while something loads, in order. */
export const MARK_CELLS: readonly Cell[] = cellsOf(GLYPH_MARK);
export const MARK_SMALL_CELLS: readonly Cell[] = cellsOf(GLYPH_MARK_SMALL);
export const WORDMARK_CELLS: readonly Cell[] = WORDMARK_GLYPHS.flatMap((g) => cellsOf(g.rows, g.dx, g.dy));
