import { MARK_CELLS, MARK_GRID } from "./mark-cells";

/**
 * The Christopher mark. It is the only graphic in the product — there is no
 * icon set, and the wordmark never appears inside the app.
 */
export function Mark({
  size = 48,
  searching = false,
  title = null,
  className = "",
}: {
  /** Rendered width and height. Snapped to a whole multiple of 16 so cells
      land on device pixels. */
  size?: number;
  /** Turn the wheel, for "Christopher is scanning boards". Eight steps per
      revolution; `prefers-reduced-motion` stops it. */
  searching?: boolean;
  /** Accessible name. Leave null for decoration sitting beside real text. */
  title?: string | null;
  className?: string;
}) {
  const snapped = Math.max(MARK_GRID, Math.round(size / MARK_GRID) * MARK_GRID);
  return (
    <svg
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      width={snapped}
      height={snapped}
      shapeRendering="crispEdges"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={`block ${searching ? "animate-paddle" : ""} ${className}`}
    >
      <g fill="currentColor">
        {MARK_CELLS.map((cell) => (
          <rect key={`${cell.x},${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />
        ))}
      </g>
    </svg>
  );
}
