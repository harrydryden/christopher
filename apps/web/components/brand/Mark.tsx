import { MARK_CELLS, MARK_PATH, MARK_TILE } from "./mark-cells";
import { MarkTiles, type MarkProps } from "./MarkTiles";

export type { MarkProps } from "./MarkTiles";

/**
 * The Course of Life mark: a C-shaped path — the wordmark's own C, with 2-cell strokes and its
 * corners cut — and a 4-cell point at its opening on the baseline, where the path leads, on a
 * 24-cell tile, drawn in `currentColor` — light green on the green sign-in panel, `text-brand` on
 * white.
 * It is the only graphic in the product besides the wordmark — there is no icon set. At 16px, use
 * the `MarkSmall`, which is the same artwork on a tile that lands on whole pixels there.
 */
export function Mark(props: MarkProps) {
  return <MarkTiles {...props} path={MARK_PATH} width={MARK_TILE} height={MARK_TILE} tile={MARK_TILE} cells={MARK_CELLS} />;
}
