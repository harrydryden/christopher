/**
 * The artwork is data, so its invariants are checked here: the wordmark's two lines share one
 * measure, the mark's tiles are square, and the blank pixel's path covers every filled cell once,
 * in plotter order.
 */
import { describe, expect, it } from "vitest";
import {
  GLYPH_MARK, GLYPH_MARK_SMALL, MARK_CELLS, MARK_SMALL_CELLS, MARK_SMALL_TILE, MARK_TILE, WORDMARK_CELLS,
  WORDMARK_GLYPHS, WORDMARK_LETTERS, WORDMARK_LINES, WORDMARK_TILE, WORDMARK_WIDTH, cellsOf,
} from "./mark-cells";

const filled = (rows: readonly string[]) => rows.join("").split("").filter((c) => c === "#").length;

describe("the wordmark", () => {
  it("sets both lines to the same 29-cell measure", () => {
    expect(WORDMARK_WIDTH).toBe(29);
    for (const line of WORDMARK_LINES) {
      const glyphs = [...line.text].map((ch) => WORDMARK_LETTERS[ch]!);
      const width = glyphs.reduce((w, rows) => w + rows[0]!.length, 0) + (glyphs.length - 1) * line.gap;
      expect(width, line.text).toBe(29);
    }
  });

  it("keeps every placed glyph inside its 29×16 box", () => {
    expect(WORDMARK_TILE).toBe(16);
    for (const { rows, dx, dy } of WORDMARK_GLYPHS) {
      expect(dx + rows[0]!.length).toBeLessThanOrEqual(WORDMARK_WIDTH);
      expect(dy + rows.length).toBeLessThanOrEqual(WORDMARK_TILE);
    }
  });

  it("passes the blank pixel through every filled cell exactly once", () => {
    const total = WORDMARK_GLYPHS.reduce((n, g) => n + filled(g.rows), 0);
    expect(WORDMARK_CELLS).toHaveLength(total);
    expect(new Set(WORDMARK_CELLS.map((c) => `${c.x},${c.y}`)).size).toBe(total);
  });
});

describe("the mark", () => {
  it("is drawn on square tiles", () => {
    expect(GLYPH_MARK).toHaveLength(MARK_TILE);
    expect(GLYPH_MARK.every((row) => row.length === MARK_TILE)).toBe(true);
    expect(GLYPH_MARK_SMALL).toHaveLength(MARK_SMALL_TILE);
    expect(GLYPH_MARK_SMALL.every((row) => row.length === MARK_SMALL_TILE)).toBe(true);
  });

  it("passes the blank pixel through every filled cell of both tiles", () => {
    expect(MARK_CELLS).toHaveLength(filled(GLYPH_MARK));
    expect(MARK_SMALL_CELLS).toHaveLength(filled(GLYPH_MARK_SMALL));
  });
});

describe("cellsOf", () => {
  it("orders cells column-major, each column top to bottom, offset by dx and dy", () => {
    expect(cellsOf(["#.#", "##.", ".##"], 10, 20)).toEqual([
      { x: 10, y: 20 },
      { x: 10, y: 21 },
      { x: 11, y: 21 },
      { x: 11, y: 22 },
      { x: 12, y: 20 },
      { x: 12, y: 22 },
    ]);
  });
});
