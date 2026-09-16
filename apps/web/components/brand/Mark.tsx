import { MARK_GRID, MARK_PATH } from "./mark-cells";

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
  /** Turn the wheel. This is the product's one loading indicator — a page
      loading, a CV building, a search in flight — and is otherwise still.
      Eight steps per revolution; `prefers-reduced-motion` stops it. */
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
      <path d={MARK_PATH} fill="currentColor" />
    </svg>
  );
}
