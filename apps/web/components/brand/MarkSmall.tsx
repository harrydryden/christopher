import { MARK_SMALL_CELLS, MARK_SMALL_PATH, MARK_SMALL_TILE } from "./mark-cells";
import { MarkTiles, type MarkProps } from "./MarkTiles";

/**
 * The mark on its own 16-cell tile, and the favicon. It stands in for the mark at 16px — the
 * status strip and every inline loading indicator — where the 24-cell tile would split pixels,
 * and redraws the same way. Drawn in `currentColor`, like every form of the mark.
 */
export function MarkSmall(props: MarkProps) {
  return (
    <MarkTiles
      size={16}
      {...props}
      path={MARK_SMALL_PATH}
      width={MARK_SMALL_TILE}
      height={MARK_SMALL_TILE}
      tile={MARK_SMALL_TILE}
      cells={MARK_SMALL_CELLS}
    />
  );
}
