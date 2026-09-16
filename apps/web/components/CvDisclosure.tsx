"use client";
import { useId, useState, type ReactNode } from "react";

export function CvDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
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
        {children}
      </div>
    </div>
  );
}
