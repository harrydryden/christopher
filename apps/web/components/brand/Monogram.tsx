import { MarkTiles, type MarkProps } from "./Mark";
import { MONOGRAM_PATH, TILE } from "./mark-cells";

const PATHS = [MONOGRAM_PATH] as const;

/**
 * The compact form of the mark: the A tile alone, 16 cells square. It stands in where the wordmark
 * would be too wide — the status strip and every inline loading indicator at 16px — and turns the
 * same way, one letter instead of three.
 */
export function Monogram(props: MarkProps) {
  return <MarkTiles {...props} width={TILE} paths={PATHS} />;
}
