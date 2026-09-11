import {
  BARS,
  BAR_GRADIENTS,
  BLOCK,
  GRADIENTS,
  LAYOUT,
  WHEEL,
  WHEELS,
  WHEEL_KEYS,
} from "./artwork";

/**
 * The four-drum mark, simplified build (BRAND.md: 40-160px).
 *
 * `searching` turns the drums at the speeds and directions from the design's
 * motion spec; `prefers-reduced-motion` stops them, handled in globals.css.
 */
export function ChristopherMark({
  size = 40,
  searching = false,
  bars = true,
  title = null,
  id = "christopher-mark",
  className,
}: {
  /** Rendered width and height in px. */
  size?: number;
  /** Turn the drums, for "Christopher is scanning boards". */
  searching?: boolean;
  /** Steel bars behind the block. Drop them when the mark sits very small. */
  bars?: boolean;
  /** Accessible name. Leave null for decoration sitting beside real text. */
  title?: string | null;
  /**
   * Namespace for the gradient ids. SVG ids are document-global, so give each
   * mark on a page its own value.
   */
  id?: string;
  className?: string;
}) {
  // `artwork.ts` marks every gradient id with "@" for exactly this.
  const scope = (svg: string) => svg.replaceAll("@", `${id}-`);

  return (
    <svg
      viewBox={`0 0 ${BLOCK} ${BLOCK}`}
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs dangerouslySetInnerHTML={{ __html: scope(GRADIENTS + BAR_GRADIENTS) }} />
      <defs>
        <filter id={`${id}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#000" floodOpacity="0.5" />
        </filter>
      </defs>

      {bars ? <g dangerouslySetInnerHTML={{ __html: scope(BARS) }} /> : null}

      {WHEEL_KEYS.map((key) => {
        const { x, y, seconds, direction } = LAYOUT[key];
        return (
          // The shadow lives outside the spin so the light source stays put.
          <g key={key} filter={`url(#${id}-shadow)`}>
            {/* A nested viewport makes the drum centre exactly 100,100 locally,
                so the rotation origin needs no correction for the offset. */}
            <svg x={x} y={y} width={WHEEL} height={WHEEL} viewBox={`0 0 ${WHEEL} ${WHEEL}`} overflow="visible">
              <g
                className={searching ? "christopher-wheel" : undefined}
                style={
                  searching
                    ? {
                        transformBox: "view-box",
                        transformOrigin: "100px 100px",
                        animationName: direction === "cw" ? "christopher-cw" : "christopher-ccw",
                        animationDuration: `${seconds}s`,
                        animationTimingFunction: "linear",
                        animationIterationCount: "infinite",
                      }
                    : undefined
                }
                dangerouslySetInnerHTML={{ __html: scope(WHEELS[key]) }}
              />
            </svg>
          </g>
        );
      })}
    </svg>
  );
}
