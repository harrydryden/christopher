/**
 * Every form of the mark is one svg with one path, snapped to its tile, and only the loading
 * indicator carries the blank cell that redraws it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Mark, MarkSmall, Wordmark } from "./index";
import { MARK_BEAT_SECONDS } from "./MarkTiles";
import { MARK_SMALL_CELLS, WORDMARK_CELLS } from "./mark-cells";

it("draws each artwork as one path, snapped to a whole multiple of its tile", () => {
  const mark = renderToStaticMarkup(<Mark size={50} />);
  expect(mark).toContain('viewBox="0 0 24 24"');
  expect(mark).toContain('width="48" height="48"');
  expect(mark.match(/<path /g)).toHaveLength(1);
  expect(mark).toContain('aria-hidden="true"');

  expect(renderToStaticMarkup(<MarkSmall />)).toContain('width="16" height="16"');
  const wordmark = renderToStaticMarkup(<Wordmark size={48} title="Course of Life" />);
  expect(wordmark).toContain('viewBox="0 0 29 16"');
  expect(wordmark).toContain('width="87" height="48"');
  expect(wordmark).toContain('role="img"');
  expect(wordmark).toContain('aria-label="Course of Life"');
});

it("is still unless searching", () => {
  expect(renderToStaticMarkup(<Wordmark />)).not.toContain("ds-mark-blank");
  expect(renderToStaticMarkup(<Wordmark />)).not.toContain("<animate");
});

it("steps one blank cell through the cells in order, one beat each, while searching", () => {
  const html = renderToStaticMarkup(<MarkSmall searching title="Saving" />);
  expect(html).toContain('<rect width="1" height="1" class="ds-mark-blank">');
  const dur = `${+(MARK_SMALL_CELLS.length * MARK_BEAT_SECONDS).toFixed(3)}s`;
  expect(html).toContain(`attributeName="x" values="${MARK_SMALL_CELLS.map((c) => c.x).join(";")}" calcMode="discrete" dur="${dur}" repeatCount="indefinite"`);
  expect(html).toContain(`attributeName="y" values="${MARK_SMALL_CELLS.map((c) => c.y).join(";")}" calcMode="discrete" dur="${dur}" repeatCount="indefinite"`);

  const wordmark = renderToStaticMarkup(<Wordmark searching />);
  expect(wordmark).toContain(`dur="${+(WORDMARK_CELLS.length * MARK_BEAT_SECONDS).toFixed(3)}s"`);
});
