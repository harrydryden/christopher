import {
  WORDMARK_BOTTOM,
  WORDMARK_CAP_HEIGHT,
  WORDMARK_LEFT,
  WORDMARK_PATH,
  WORDMARK_RIGHT,
  WORDMARK_TOP,
} from "./artwork";

// The path carries a left side bearing on the "C". Trimming to the ink box is
// what makes the lockup gap measure from the glyph edge, as the lockup rules specify.
const INK_LEFT = WORDMARK_LEFT;
const INK_WIDTH = WORDMARK_RIGHT - WORDMARK_LEFT;
const INK_HEIGHT = WORDMARK_BOTTOM - WORDMARK_TOP;

/** Width this wordmark will occupy at a given cap height. */
export function wordmarkWidth(capHeight: number) {
  return (INK_WIDTH * capHeight) / WORDMARK_CAP_HEIGHT;
}

/**
 * "Christopher" in Spectral Medium, pre-outlined — no webfont, no FOUT, and no
 * silent fallback to Georgia on a machine without Spectral installed.
 */
export function ChristopherWordmark({
  capHeight = 20,
  fill = "currentColor",
  title = null,
  className,
}: {
  /** Cap height in px. In a lockup this is pinned to one wheel diameter. */
  capHeight?: number;
  fill?: string;
  title?: string | null;
  className?: string;
}) {
  const scale = capHeight / WORDMARK_CAP_HEIGHT;
  return (
    <svg
      viewBox={`${INK_LEFT} ${WORDMARK_TOP} ${INK_WIDTH} ${INK_HEIGHT}`}
      width={INK_WIDTH * scale}
      height={INK_HEIGHT * scale}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={WORDMARK_PATH} fill={fill} />
    </svg>
  );
}
