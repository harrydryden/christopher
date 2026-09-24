import { TILE, WORDMARK_PATHS, WORDMARK_WIDTH } from "./mark-cells";

export interface MarkProps {
  /** Rendered height. Snapped to a whole multiple of 16 so cells land on device pixels; the
      width follows the artwork. */
  size?: number;
  /** Turn the letters. This is the product's one loading indicator — a page loading, a CV
      building, a search in flight — and is otherwise still. Each letter turns once in eight
      steps, a beat behind the one before it, then all rest upright; `prefers-reduced-motion`
      stops it. */
  searching?: boolean;
  /** Accessible name. Leave null for decoration sitting beside real text. */
  title?: string | null;
  className?: string;
}

/**
 * The tiles both forms of the mark are drawn on: one `<path>` per letter, so each turns about its
 * own box (`ds-mark-letter`) while `ds-mark-turning` on the svg sets them going.
 */
export function MarkTiles({
  width,
  paths,
  size = 48,
  searching = false,
  title = null,
  className = "",
}: MarkProps & { width: number; paths: readonly string[] }) {
  const height = Math.max(TILE, Math.round(size / TILE) * TILE);
  return (
    <svg
      viewBox={`0 0 ${width} ${TILE}`}
      width={(height * width) / TILE}
      height={height}
      shapeRendering="crispEdges"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={`block ${searching ? "ds-mark-turning" : ""} ${className}`}
    >
      {paths.map((d, index) => (
        <path key={index} d={d} className="ds-mark-letter ds-animate" />
      ))}
    </svg>
  );
}

/**
 * The AVA mark, which is also the wordmark: A V A in pixel letters, 48 cells wide by 16 tall. It
 * is the only graphic in the product — there is no icon set. Where it would be too wide, use the
 * `Monogram`.
 */
export function Mark(props: MarkProps) {
  return <MarkTiles {...props} width={WORDMARK_WIDTH} paths={WORDMARK_PATHS} />;
}
