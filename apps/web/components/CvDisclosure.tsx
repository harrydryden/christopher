"use client";
import { startTransition, useId, useState, type ReactNode } from "react";

/**
 * A labelled show/hide. Closed, its contents are rendered and hidden, so find-in-page and the
 * server's HTML still hold them; with `mountWhenOpen` they are rendered only while it is open,
 * for contents that cost something to work out (a build's narrative, re-told every second while
 * the build runs) or to download.
 *
 * Contents that are a chunk of their own suspend the first time they render. Opening is then a
 * transition: the button stays as it was, and the rest of the page stays responsive, until the
 * chunk has arrived, rather than the whole page holding still for it (there is no Suspense
 * boundary here to show a fallback, deliberately; see CvLazyWidgets).
 */
export function CvDisclosure({
  label,
  children,
  mountWhenOpen = false,
}: {
  label: string;
  children: ReactNode;
  mountWhenOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = () => setOpen((value) => !value);
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (mountWhenOpen ? startTransition(toggle) : toggle())}
        className="border border-line-muted px-3 py-1.5 text-12 font-medium text-fg hover:bg-sunken"
      >
        {open ? "Hide" : "Show"} {label}
      </button>
      <div id={id} hidden={!open} className="space-y-2">
        {(open || !mountWhenOpen) && children}
      </div>
    </div>
  );
}
