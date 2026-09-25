import { TILE, WORDMARK_PATHS, WORDMARK_WIDTH } from "./mark-cells";

export interface MarkProps {
  /** Rendered height. Snapped to a whole multiple of the tile (24 for the wordmark, 16 for the
      monogram) so cells land on device pixels; the width follows the artwork. */
  size?: number;
  /** Turn the letters. This is the product's one loading indicator — a page loading, a CV
      building, a search in flight — and is otherwise still. Each letter turns once about its own
      upright axis in eight steps, a beat behind the one before it, then all rest upright;
      `prefers-reduced-motion` stops it. */
  searching?: boolean;
  /** Accessible name. Leave null for decoration sitting beside real text. */
  title?: string | null;
  className?: string;
}

/** One layer of a letter: a path, and the fill class it takes (none means `currentColor`). */
export interface MarkLayer {
  d: string;
  className?: string;
}

/**
 * The tiles both forms of the mark are drawn on: one element per letter, so each turns about its
 * own box (`ds-mark-letter`) while `ds-mark-turning` on the svg sets them going. A letter of one
 * layer is a `<path>`; a letter of several (the monogram's triangle and A) is a `<g>` of them, so
 * the layers turn together.
 */
export function MarkTiles({
  width,
  tile,
  letters,
  size = 48,
  searching = false,
  title = null,
  className = "",
}: MarkProps & { width: number; tile: number; letters: ReadonlyArray<ReadonlyArray<MarkLayer>> }) {
  const height = Math.max(tile, Math.round(size / tile) * tile);
  return (
    <svg
      viewBox={`0 0 ${width} ${tile}`}
      width={(height * width) / tile}
      height={height}
      shapeRendering="crispEdges"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={`block ${searching ? "ds-mark-turning" : ""} ${className}`}
    >
      {letters.map((layers, index) =>
        layers.length === 1 ? (
          <path key={index} d={layers[0]!.d} className={`ds-mark-letter ds-animate ${layers[0]!.className ?? ""}`} />
        ) : (
          <g key={index} className="ds-mark-letter ds-animate">
            {layers.map((layer, i) => <path key={i} d={layer.d} className={layer.className} />)}
          </g>
        ),
      )}
    </svg>
  );
}

const LETTERS = WORDMARK_PATHS.map((d) => [{ d }]);

/**
 * The AVA mark, which is also the wordmark: A V A in pixel letters, 52 cells wide by 24 tall,
 * drawn in `currentColor` — light green on the green sidebar and sign-in panel, `text-brand` on
 * white. It is the only graphic in the product — there is no icon set. Where it would be too
 * wide, use the `Monogram`.
 */
export function Mark(props: MarkProps) {
  return <MarkTiles {...props} width={WORDMARK_WIDTH} tile={TILE} letters={LETTERS} />;
}
