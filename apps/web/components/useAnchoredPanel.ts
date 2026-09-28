"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The step between a trigger and its panel, and the panel's margin from the edge of the screen:
 * one unit of the 4px scale, so an open panel sits on the grid like everything else.
 */
export const ANCHOR_GAP = 4;

/**
 * A panel laid out against the viewport from its trigger's own rectangle, for a control that lives
 * inside a horizontal scroller.
 *
 * A scroller clips anything positioned inside it the moment it reaches the bottom of the box — on
 * the last row of a table, which is often the row just added. So the open panel is fixed-positioned
 * from the trigger's rectangle, measured again on every scroll and resize while it is open, and
 * flipped above the trigger when it would fall off the bottom of the screen. Scrolled past its own
 * row, the panel has nothing left to be beside and closes, unless focus is inside it.
 *
 * A pointer or a focus anywhere outside `root` closes it too, without moving the caret back: the
 * person has already gone somewhere else. Escape and Tab are the caller's, because what they do
 * depends on what the panel is.
 *
 * `onOpen` runs once each time the panel opens, after it has been placed and before it is painted:
 * the moment to move focus into it.
 */
export function useAnchoredPanel({
  open,
  setOpen,
  root,
  trigger,
  panel,
  onOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  root: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  onOpen?: () => void;
}) {
  const opened = useRef(onOpen);
  const close = useRef(setOpen);
  // The latest callbacks, without making them reasons to re-run the effects below.
  useLayoutEffect(() => {
    opened.current = onOpen;
    close.current = setOpen;
  });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const sheet = panel.current;
      const anchor = trigger.current?.getBoundingClientRect();
      if (!sheet || !anchor) return;
      const gone = anchor.bottom < 0 || anchor.top > window.innerHeight || anchor.right < 0 || anchor.left > window.innerWidth;
      if (gone && !sheet.contains(document.activeElement)) return close.current(false);
      const { offsetWidth: width, offsetHeight: height } = sheet;
      const below = anchor.bottom + ANCHOR_GAP;
      const above = anchor.top - ANCHOR_GAP - height;
      const top = below + height <= window.innerHeight || above < ANCHOR_GAP ? below : above;
      sheet.style.left = `${Math.max(ANCHOR_GAP, Math.min(anchor.left, window.innerWidth - width - ANCHOR_GAP))}px`;
      sheet.style.top = `${Math.max(ANCHOR_GAP, Math.min(top, window.innerHeight - height - ANCHOR_GAP))}px`;
    };
    place();
    opened.current?.();
    // Captured, because the scroll that moves the row is the scroller's own and does not bubble.
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
    // Opening is the only thing this is about; refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close.current(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
