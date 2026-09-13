"use client";
import { useState, type ReactNode } from "react";

/** Keep the editor mounted when the reference panel closes, preserving unsaved edits. */
export function CvWorkspace({
  children,
  description,
}: {
  children: ReactNode;
  description: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="cv-job-description"
          onClick={() => setOpen((value) => !value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-accent hover:bg-slate-50"
        >
          {open ? "Hide job description" : "Show job description"}
        </button>
      </div>
      <div
        className={`grid items-start gap-6 ${open ? "lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]" : "grid-cols-1"}`}
      >
        <div className="min-w-0 space-y-5">{children}</div>
        <aside
          id="cv-job-description"
          hidden={!open}
          className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 lg:sticky lg:top-6"
        >
          <details open className="group">
            <summary className="cursor-pointer border-b border-slate-200 px-5 py-4 font-semibold text-accent">
              Job description{" "}
              <span className="ml-2 text-xs font-normal text-slate-500">
                <span className="hidden group-open:inline">
                  Click to minimise
                </span>
                <span className="group-open:hidden">Click to expand</span>
              </span>
            </summary>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto break-words p-5 text-sm leading-relaxed lg:max-h-[calc(100vh-10rem)]">
              {description}
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
