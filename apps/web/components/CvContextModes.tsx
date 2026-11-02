"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { CvEditingMode } from "@col/core/cv-editing-modes";

/** Primary modes stay mounted after a visit so local wording survives a mode switch. */
export function CvContextModes({ initialMode, auto, refine, manual }: {
  initialMode: CvEditingMode; auto: ReactNode; refine: ReactNode; manual: ReactNode;
}) {
  const [mode, setMode] = useState<CvEditingMode>(initialMode);
  const [visited, setVisited] = useState<Set<CvEditingMode>>(() => new Set([initialMode]));
  useEffect(() => {
    const hasDirtyBuffer = () => !!document.querySelector('[data-cv-mode-dirty="true"]');
    const unloading = (event: BeforeUnloadEvent) => {
      if (hasDirtyBuffer()) { event.preventDefault(); event.returnValue = ""; }
    };
    const navigating = (event: MouseEvent) => {
      if (!hasDirtyBuffer() || event.defaultPrevented) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      const next = new URL(anchor.getAttribute("href")!, window.location.href);
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (!window.confirm("Leave this application with unsaved CV wording? Your edits will remain only on this page."))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unloading);
    document.addEventListener("click", navigating, true);
    return () => { window.removeEventListener("beforeunload", unloading); document.removeEventListener("click", navigating, true); };
  }, []);
  const select = (next: CvEditingMode) => { setVisited(previous => new Set([...previous, next])); setMode(next); };
  const tabs = [{ id: "auto" as const, label: "Auto", hint: "From Experience and this role" },
    { id: "refine" as const, label: "Refine", hint: "Remembered for this role" },
    { id: "manual" as const, label: "Manual", hint: "This version only" }];
  return <div className="space-y-4">
    <div role="group" aria-label="CV editing mode" className="grid gap-2 sm:grid-cols-3">
      {tabs.map(tab => <button key={tab.id} type="button"
        id={`cv-mode-${tab.id}`} aria-controls={`cv-mode-panel-${tab.id}`} aria-pressed={mode === tab.id}
        className={`min-h-11 border p-3 text-left ${mode === tab.id ? "border-accent bg-accent text-accent-fg" : "border-line-muted bg-raised"}`}
        onClick={() => select(tab.id)}>
        <strong className="block text-14">{tab.label}</strong><span className="block text-12">{tab.hint}</span>
      </button>)}
    </div>
    {tabs.map(tab => <section key={tab.id} id={`cv-mode-panel-${tab.id}`}
      aria-labelledby={`cv-mode-${tab.id}`} hidden={mode !== tab.id}>
      {visited.has(tab.id) ? tab.id === "auto" ? auto : tab.id === "refine" ? refine : manual : null}
    </section>)}
  </div>;
}
