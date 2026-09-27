"use client";
import { useId, useState, type ReactNode } from "react";

/**
 * A labelled show/hide. Closed, its contents are rendered and hidden, so find-in-page and the
 * server's HTML still hold them; with `mountWhenOpen` they are rendered only while it is open,
 * for contents that cost something to work out (a build's narrative, re-told every second while
 * the build runs) or to download.
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
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
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
