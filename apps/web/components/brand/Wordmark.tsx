import { WORDMARK_CELLS, WORDMARK_PATH, WORDMARK_TILE, WORDMARK_WIDTH } from "./mark-cells";
import { MarkTiles, type MarkProps } from "./MarkTiles";

/**
 * The wordmark: the domain stacked, `course` over `of.life`, lowercase pixel letters 29 cells wide
 * by 16 tall, drawn in `currentColor`. It sits under the mark on the sign-in panel, heads the
 * sidebar, and is the loading indicator wherever a whole region is waiting.
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
