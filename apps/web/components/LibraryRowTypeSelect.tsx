"use client";
import { useEffect, useRef } from "react";
import { EVIDENCE_FACETS, EVIDENCE_FACET_LABELS, type EvidenceFacet } from "@ava/core/cv";
import { Checkbox } from "@/components/Field";

/**
 * The step between the summary and its panel, and the panel's margin from the edge of the screen:
 * one unit of the 4px scale, so the open panel sits on the grid like everything else.
 */
const GAP = 4;

/**
 * What one row of evidence is for, as a column of the rows table rather than a question under it.
 *
 * It takes several answers at once, because one narrative is often the problem somebody solved
 * *and* the figure it moved, and a row that is both should count as both rather than force a
 * choice. So it is a disclosure rather than a `<select>`: the summary reads back what is chosen,
 * and the panel is six checkboxes in the order the Library asks for them.
 *
 * The panel overlays the row below it instead of pushing the table around, which is what a
 * multi-select in a dense table has to do; a click outside or Escape closes it, and everything it
 * does is reachable from the keyboard alone — Tab to the summary, Enter or Space to open, Tab
 * through the six, Escape to close and come back to the summary.
 *
 * It overlays the *page*, not the table. The rows table is a horizontal scroller, and a scroller
 * with a non-visible `overflow-x` has a non-visible `overflow-y` too, so a panel positioned inside
 * it is clipped the moment it reaches the bottom of the box — on the last row of a job, which is
 * the row just added and the one most likely to be tagged. Positioned from the summary's own
 * rectangle instead, it is laid out against the viewport and nothing clips it; the price is that
 * those coordinates drift under any scroll, so they are measured again on every scroll and resize
 * while the panel is open, and it flips above the summary when it would fall off the bottom.
 *
 * The group is named on the `<details>`, not on the panel: a panel inside a closed disclosure is
 * hidden from the accessibility tree, and the control has to be findable — by a person and by a
 * test — whether or not it happens to be open. The panel stays where it is written, inside the
 * row, so Tab reaches it from the summary and leaves it into the row's own Remove.
 */
export function LibraryRowTypeSelect({
  label,
  value,
  onChange,
}: {
  /** "Type of row 3": what this control is, in the row it belongs to. */
  label: string;
  value: readonly EvidenceFacet[];
  onChange: (facets: EvidenceFacet[]) => void;
}) {
  const box = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Everything an open panel has to answer to: a click or a focus elsewhere and an Escape close
  // it, and a scroll or a resize move it, because what it is positioned against is the viewport.
  // Each document-level handler asks whether this panel is open before anything else, so a closed
  // control costs one comparison per event.
  useEffect(() => {
    const details = box.current;
    if (!details) return;
    /**
     * Put the open panel under its summary, in viewport coordinates: below when there is room,
     * above when there is not, and never past an edge of the screen.
     */
    const place = () => {
      const sheet = panel.current;
      const summary = details.querySelector("summary");
      if (!details.open || !sheet || !summary) return;
      const anchor = summary.getBoundingClientRect();
      // Scrolled past its own row, the panel has nothing left to be beside, so it goes — unless
      // somebody is tabbing through it, which is not a moment to take a control away.
      const gone = anchor.bottom < 0 || anchor.top > window.innerHeight || anchor.right < 0 || anchor.left > window.innerWidth;
      if (gone && !details.contains(document.activeElement)) {
        details.open = false;
        return;
      }
      const { offsetWidth: width, offsetHeight: height } = sheet;
      const below = anchor.bottom + GAP;
      const above = anchor.top - GAP - height;
      const top = below + height <= window.innerHeight || above < GAP ? below : above;
      sheet.style.left = `${Math.max(GAP, Math.min(anchor.left, window.innerWidth - width - GAP))}px`;
      sheet.style.top = `${Math.max(GAP, Math.min(top, window.innerHeight - height - GAP))}px`;
    };
    const outside = (event: Event) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details.open) return;
      event.stopPropagation();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    details.addEventListener("keydown", escape);
    details.addEventListener("toggle", place);
    // Captured, because the scroll that moves this row is the table's own and does not bubble.
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      details.removeEventListener("keydown", escape);
      details.removeEventListener("toggle", place);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, []);

  function toggle(facet: EvidenceFacet, on: boolean) {
    const next = new Set(value);
    if (on) next.add(facet); else next.delete(facet);
    onChange(EVIDENCE_FACETS.filter(item => next.has(item)));
  }

  return (
    <details ref={box} role="group" aria-label={label} className="w-full">
      <summary
        aria-label={label}
        className="min-h-11 cursor-pointer border-2 border-line-muted bg-bg px-3 py-3 text-12"
      >
        {summaryLabel(value)}
      </summary>
      {/* A grid, because the checkbox labels are inline-flex: one type to a line, six lines. The
          coordinates are set when it opens; until then it falls where it is written. */}
      <div ref={panel} className="fixed z-20 grid w-60 gap-2 border-2 border-line bg-raised p-3 shadow-hard-1">
        {EVIDENCE_FACETS.map(facet => (
          <Checkbox
            key={facet}
            checked={value.includes(facet)}
            onChange={event => toggle(facet, event.target.checked)}
            label={EVIDENCE_FACET_LABELS[facet]}
          />
        ))}
      </div>
    </details>
  );
}

/**
 * What the summary reads: the types chosen, or the prompt to choose one.
 *
 * Two names fit the column; past that it is the first two and how many more, because the point of
 * the line is to say at a glance what this row counts as, not to list it.
 */
export function summaryLabel(value: readonly EvidenceFacet[]) {
  if (!value.length) return <span className="text-faint">Choose a type</span>;
  const named = value.slice(0, 2).map(facet => EVIDENCE_FACET_LABELS[facet]).join(" · ");
  return <span>{value.length > 2 ? `${named} +${value.length - 2}` : named}</span>;
}
