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
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-accent hover:bg-slate-50"
      >
        {open ? "Hide" : "Show"} {label}
      </button>
      <div id={id} hidden={!open} className="space-y-2">
        {children}
      </div>
    </div>
  );
}
