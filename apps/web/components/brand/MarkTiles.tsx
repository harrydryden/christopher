import type { Cell } from "./mark-cells";

export interface MarkProps {
  /** Rendered height. Snapped to a whole multiple of the artwork's tile (24 for the mark, 16 for
      the small mark and the wordmark) so cells land on device pixels; the width follows the
      artwork. */
  size?: number;
  /** Redraw the artwork. This is the product's one loading indicator — a page loading, a CV
      building, a search in flight — and is otherwise still. A single blank cell, in the colour of
      the ground, passes through the filled cells in plotter order (columns left to right, each top
      to bottom), one cell per beat, stepped and looping; `prefers-reduced-motion` hides it. */
  searching?: boolean;
  /** Accessible name. Leave null for decoration sitting beside real text. */
  title?: string | null;
  className?: string;
}

/**
 * How long the blank cell rests on each cell while the artwork is redrawn, in seconds. The beat
 * is the same for every artwork, so a bigger one takes longer to redraw rather than moving faster:
 * the small mark's 46 cells come round in 2.2s, the mark's 66 in 3.2s, the wordmark's 116 in 5.6s.
 */
export const MARK_BEAT_SECONDS = 0.048;

/**
 * The renderer every form of the mark shares: one svg, one path of horizontal runs in
 * `currentColor`, and, while `searching`, one blank cell stepped through `cells` by SMIL, so the
 * animation is part of the element and no per-artwork CSS exists. `.ds-mark-blank` paints the
 * cell in `--mark-ground` (the page white, or the green inside `ds-on-brand`) and hides it under
 * reduced motion.
 */
export function MarkTiles({
  path,
  width,
  height: artHeight,
  tile,
  cells,
  size = 48,
  searching = false,
  title = null,
  className = "",
}: MarkProps & { path: string; width: number; height: number; tile: number; cells: readonly Cell[] }) {
  const height = Math.max(tile, Math.round(size / tile) * tile);
  const dur = `${+(cells.length * MARK_BEAT_SECONDS).toFixed(3)}s`;
  return (
    <svg
      viewBox={`0 0 ${width} ${artHeight}`}
      width={(height * width) / artHeight}
      height={height}
      shapeRendering="crispEdges"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={`block ${className}`}
    >
      <path d={path} />
      {searching && cells.length > 0 ? (
        <rect width="1" height="1" className="ds-mark-blank">
          <animate
            attributeName="x"
            values={cells.map((c) => c.x).join(";")}
            calcMode="discrete"
            dur={dur}
            repeatCount="indefinite"
          />
          <animate
            attributeName="y"
            values={cells.map((c) => c.y).join(";")}
            calcMode="discrete"
            dur={dur}
            repeatCount="indefinite"
          />
        </rect>
      ) : null}
    </svg>
  );
}
