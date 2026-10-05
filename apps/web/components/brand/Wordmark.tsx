import { WORDMARK_CELLS, WORDMARK_PATH, WORDMARK_TILE, WORDMARK_WIDTH } from "./mark-cells";
import { MarkTiles, type MarkProps } from "./MarkTiles";

/**
 * The wordmark: the domain stacked, `COURSE` over `OF.LIFE`, in 5-by-7 pixel capitals with both
 * lines justified to one measure of 50 cells, 16 cells tall, drawn in `currentColor` (150×48 at
 * size 48). It sits under the mark on the sign-in panel, heads the sidebar, and is the loading
 * indicator wherever a whole region is waiting.
 */
export function Wordmark(props: MarkProps) {
  return (
    <MarkTiles
      {...props}
      path={WORDMARK_PATH}
      width={WORDMARK_WIDTH}
      height={WORDMARK_TILE}
      tile={WORDMARK_TILE}
      cells={WORDMARK_CELLS}
    />
  );
}
