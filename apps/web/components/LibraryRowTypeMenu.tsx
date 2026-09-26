"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { EVIDENCE_FACETS, EVIDENCE_FACET_LABELS, type EvidenceFacet } from "@ava/core/cv-helpers";
import { Badge } from "@/components/Badge";

/**
 * The step between the trigger and its menu, and the menu's margin from the edge of the screen:
 * one unit of the 4px scale, so the open menu sits on the grid like everything else.
 */
const GAP = 4;

/**
 * What one row of evidence is for: a button that reads back the types chosen, and a menu of the
 * six as pixel labels that each toggle on and off.
 *
 * A row takes several types at once, because one narrative is often the problem somebody solved
 * *and* the figure it moved, and a row that is both should count as both rather than force a
 * choice. So the menu stays open while types are toggled — each item is a `menuitemcheckbox` — and
 * closes on a click or a focus outside it, on Escape, or on Tab.
 *
 * Everything is reachable from the keyboard: Enter, Space or the down arrow on the trigger opens
 * the menu on its first chosen type (or its first type); the arrows, Home and End move through it;
 * Enter or Space toggles; Escape closes it and puts the caret back on the trigger.
 *
 * The menu is laid out against the viewport, not the table cell. The rows table is a horizontal
 * scroller, and a scroller clips a menu positioned inside it the moment it reaches the bottom of
 * the box — on the last row of a job, which is the row just added and the one most likely to be
 * tagged. So it is fixed-positioned from the trigger's own rectangle, measured again on every
 * scroll and resize while it is open, and flipped above the trigger when it would fall off the
 * bottom of the screen.
 *
 * The trigger fills its cell (`h-full`) with the narrative's own minimum height, so the Type and
 * the Narrative of one row are one height however far the narrative is dragged taller.
 */
export function LibraryRowTypeMenu({
  label,
  value,
  onChange,
}: {
  /** "Type of row 3": what this control is, in the row it belongs to. */
  label: string;
  value: readonly EvidenceFacet[];
  onChange: (facets: EvidenceFacet[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const chosenId = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemcheckbox]") ?? [])];

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  // Put the open menu under its trigger, in viewport coordinates, before it is painted anywhere
  // else; then focus the item a person would want first.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const sheet = menu.current;
      const anchor = trigger.current?.getBoundingClientRect();
      if (!sheet || !anchor) return;
      // Scrolled past its own row, the menu has nothing left to be beside, so it goes — unless
      // somebody is moving through it, which is not a moment to take a control away.
      const gone = anchor.bottom < 0 || anchor.top > window.innerHeight || anchor.right < 0 || anchor.left > window.innerWidth;
      if (gone && !sheet.contains(document.activeElement)) return setOpen(false);
      const { offsetWidth: width, offsetHeight: height } = sheet;
      const below = anchor.bottom + GAP;
      const above = anchor.top - GAP - height;
      const top = below + height <= window.innerHeight || above < GAP ? below : above;
      sheet.style.left = `${Math.max(GAP, Math.min(anchor.left, window.innerWidth - width - GAP))}px`;
      sheet.style.top = `${Math.max(GAP, Math.min(top, window.innerHeight - height - GAP))}px`;
    };
    place();
    const first = items().find(item => item.getAttribute("aria-checked") === "true") ?? items()[0];
    first?.focus();
    // Captured, because the scroll that moves this row is the table's own and does not bubble.
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
    // Opening is the only thing this is about; the value changing while open must not refocus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A pointer or a focus anywhere outside the control closes it, without moving the caret back:
  // the person has already gone somewhere else.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [open]);

  function toggle(facet: EvidenceFacet) {
    const next = new Set(value);
    if (next.has(facet)) next.delete(facet); else next.add(facet);
    onChange(EVIDENCE_FACETS.filter(item => next.has(item)));
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); list[(index + list.length) % list.length]?.focus(); };
    if (event.key === "ArrowDown") return move(at + 1);
    if (event.key === "ArrowUp") return move(at - 1);
    if (event.key === "Home") return move(0);
    if (event.key === "End") return move(list.length - 1);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return close(true);
    }
    // Tab leaves the menu for the next control in the row, and the menu goes with it.
    if (event.key === "Tab") setOpen(false);
  }

  return (
    <div ref={root} className="h-full">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={chosenId}
        onClick={() => setOpen(current => !current)}
        onKeyDown={onTriggerKey}
        className={`ds-select flex h-full min-h-16 w-full cursor-pointer flex-wrap content-start items-start gap-1 border-2 bg-bg py-2 pl-3 text-left ${open ? "border-line" : "border-line-muted hover:border-line"}`}
      >
        <span id={chosenId} className="contents">{chosenLabels(value)}</span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="fixed z-20 grid w-60 gap-1 border-2 border-line bg-raised p-2 shadow-hard-1"
        >
          {EVIDENCE_FACETS.map(facet => {
            const on = value.includes(facet);
            return (
              <button
                key={facet}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                tabIndex={-1}
                onClick={() => toggle(facet)}
                className={`ds-pixel min-h-11 w-full border-2 px-3 py-2 text-left text-10 ${on ? "border-line bg-accent text-accent-fg" : "border-transparent text-fg hover:border-line-muted hover:bg-sunken"}`}
              >
                {EVIDENCE_FACET_LABELS[facet]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What the trigger reads: each type chosen, as the pixel label the menu calls it, or the prompt
 * to choose one. Every type is shown — a row carries at most six and the cell wraps them — because
 * the point of the cell is to say at a glance what this row counts as.
 */
export function chosenLabels(value: readonly EvidenceFacet[]) {
  if (!value.length) return <span className="text-12 text-faint">Choose types</span>;
  return value.map(facet => <Badge key={facet}>{EVIDENCE_FACET_LABELS[facet]}</Badge>);
}
