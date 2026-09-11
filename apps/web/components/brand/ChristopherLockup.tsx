import { BLOCK, WHEEL, WORDMARK_BOTTOM, WORDMARK_CAP_HEIGHT, WORDMARK_TOP } from "./artwork";
import { ChristopherMark } from "./ChristopherMark";
import { ChristopherWordmark, wordmarkWidth } from "./ChristopherWordmark";

/** One wheel diameter, as a fraction of the whole 408-unit block. */
const WHEEL_RATIO = WHEEL / BLOCK;

/**
 * The wordmark box reaches above the cap line (ascenders on h, t) and below the
 * baseline (descender on p), so centring the box leaves the cap band sitting
 * high. This is how far to nudge it back down, per unit of cap height.
 */
const OPTICAL_NUDGE =
  ((WORDMARK_TOP + WORDMARK_BOTTOM) / 2 - -WORDMARK_CAP_HEIGHT / 2) / WORDMARK_CAP_HEIGHT;

/** Width a horizontal lockup needs at a given mark size. Useful for fitting. */
export function lockupWidth(markSize: number) {
  return markSize + markSize / 3 + wordmarkWidth(markSize * WHEEL_RATIO);
}

/**
 * Mark plus wordmark, at the ratios BRAND.md fixes: wordmark cap height equals
 * one wheel diameter, gap equals a third of the mark width.
 *
 * BRAND.md forbids stacking below 200px wide — `orientation="stacked"` is for
 * the login card and marketing, not the sidebar.
 */
export function ChristopherLockup({
  markSize = 40,
  orientation = "horizontal",
  color = "currentColor",
  searching = false,
  id = "christopher-lockup",
  className,
}: {
  /** Rendered width of the mark in px; everything else derives from it. */
  markSize?: number;
  orientation?: "horizontal" | "stacked";
  /** Wordmark colour. Paper on navy chrome, ink on white. */
  color?: string;
  searching?: boolean;
  id?: string;
  className?: string;
}) {
  const capHeight = markSize * WHEEL_RATIO;
  const gap = markSize / 3;

  // The mark is decorative here: the wordmark already carries the name, and
  // announcing it twice is noise for a screen reader.
  const mark = (
    <ChristopherMark size={markSize} searching={searching} id={id} title={null} />
  );
  const wordmark = <ChristopherWordmark capHeight={capHeight} fill={color} title="Christopher" />;

  if (orientation === "stacked") {
    return (
      <span className={className} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap }}>
        {mark}
        {wordmark}
      </span>
    );
  }

  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap }}>
      {mark}
      <span style={{ display: "inline-flex", marginTop: OPTICAL_NUDGE * capHeight }}>{wordmark}</span>
    </span>
  );
}
