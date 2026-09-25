import { MarkTiles, type MarkProps } from "./Mark";
import { MONOGRAM_PATH, MONOGRAM_TILE, MONOGRAM_TRIANGLE_PATH } from "./mark-cells";

const LETTERS = [[
  { d: MONOGRAM_TRIANGLE_PATH, className: "fill-brand" },
  { d: MONOGRAM_PATH, className: "fill-brand-ink" },
]] as const;

/**
 * The compact form of the mark, and the favicon: a brand-green triangle with a light-green A
 * inside, on its own 16-cell tile. It stands in where the wordmark would be too wide — the status
 * strip and every inline loading indicator at 16px — and turns the same way, one letter instead
 * of three. Its two colours are fixed rather than `currentColor`, because it is the same artwork
 * as the tab icon wherever it appears.
 */
export function Monogram(props: MarkProps) {
  return <MarkTiles size={16} {...props} width={MONOGRAM_TILE} tile={MONOGRAM_TILE} letters={LETTERS} />;
}
