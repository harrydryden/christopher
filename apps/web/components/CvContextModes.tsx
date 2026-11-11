"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CvEditingMode } from "@col/core/cv-editing-modes";
import { CvContextLayout } from "./CvContextLayout";
import { cvSectionEntryId } from "@/lib/cv-content-links";
import { TaskNavigation } from "./TaskNavigation";

/** Primary modes stay mounted after a visit so local wording survives a mode switch. */
export function CvContextModes({ initialMode, auto, refine, manual, history, compare, roleDetails }: {
  initialMode: CvEditingMode; auto: ReactNode; refine: ReactNode; manual: ReactNode;
  history?: ReactNode; compare?: ReactNode; roleDetails?: ReactNode;
}) {
  const [mode, setMode] = useState<CvEditingMode>(initialMode);
  const [view, setView] = useState<"document" | "history" | "compare" | "role">("document");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [visited, setVisited] = useState<Set<CvEditingMode>>(() => new Set([initialMode]));
  useEffect(() => {
    let pendingAnchor: MutationObserver | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPending = () => { pendingAnchor?.disconnect(); pendingAnchor = null;
      if (pendingTimer) clearTimeout(pendingTimer); pendingTimer = null; };
    const navigateFragment = () => {
      clearPending();
      let hash: string;
      try { hash = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      const rawHash = window.location.hash;
      if (!hash) return;
      if (hash === "cv-history" || hash === "cv-compare" || hash === "cv-role-details") {
        setView(hash === "cv-history" ? "history" : hash === "cv-compare" ? "compare" : "role");
        requestAnimationFrame(() => document.getElementById(hash)?.focus());
        return;
      }
      setView("document");
      if (hash === "cv-panel-evaluation" || hash === "cv-guided-review" || hash.startsWith("cv-review-row-") ||
        hash === "cv-context-feedback") {
        const panel = document.getElementById("cv-context-feedback");
        if (panel) requestAnimationFrame(() => { panel.querySelector<HTMLElement>("h2[tabindex], button, a")?.focus(); panel.scrollIntoView?.(); });
      } else if (hash === "cv-panel-appearance" || hash === "cv-context-layout") {
        if (modeRef.current === "auto") { setVisited(previous => new Set([...previous, "refine"])); setMode("refine"); }
        const panel = document.getElementById("cv-context-layout");
        if (panel) requestAnimationFrame(() => { panel.querySelector<HTMLElement>("h2[tabindex], button, select")?.focus(); panel.scrollIntoView?.(); });
      } else if (hash === "cv-panel-content" || hash.startsWith("cv-content-")) {
        const next = modeRef.current === "auto" ? "refine" : modeRef.current;
        setVisited(previous => new Set([...previous, next])); setMode(next);
        requestAnimationFrame(() => {
          const panel = document.getElementById(`cv-mode-panel-${next}`);
          const entryId = cvSectionEntryId(hash);
          const findItem = () => hash === "cv-content-profile" ? panel?.querySelector<HTMLElement>('[data-cv-source-summary="true"]')
            : entryId ? [...(panel?.querySelectorAll<HTMLElement>("[data-cv-source-entry]") ?? [])]
              .find(element => element.dataset.cvSourceEntry === entryId) : null;
          const focusItem = () => {
            if (modeRef.current !== next || window.location.hash !== rawHash) { clearPending(); return true; }
            const item = findItem();
            if (!item) return false;
            (item.querySelector<HTMLElement>("button, textarea, input") ?? item).focus();
            item.scrollIntoView?.(); clearPending(); return true;
          };
          if (!focusItem()) {
            document.getElementById(`cv-mode-${next}`)?.focus();
            if (panel && (entryId || hash === "cv-content-profile")) {
              pendingAnchor = new MutationObserver(() => { focusItem(); });
              pendingAnchor.observe(panel, { childList: true, subtree: true });
              pendingTimer = setTimeout(clearPending, 5_000);
            }
          }
        });
      } else if (hash === "cv-mode-refine" || hash === "cv-mode-manual" || hash === "cv-mode-auto") {
        const next = hash.slice("cv-mode-".length) as CvEditingMode;
        setVisited(previous => new Set([...previous, next])); setMode(next);
        requestAnimationFrame(() => document.getElementById(hash)?.focus());
      }
    };
    navigateFragment();
    window.addEventListener("hashchange", navigateFragment);
    return () => { clearPending(); window.removeEventListener("hashchange", navigateFragment); };
  }, []);
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
  const select = (next: CvEditingMode) => { setVisited(previous => new Set([...previous, next])); setMode(next); setView("document"); };
  const tabs = [{ id: "auto" as const, label: "Auto", hint: "From Experience and this role" },
    { id: "refine" as const, label: "Refine", hint: "Remembered for this role" },
    { id: "manual" as const, label: "Manual", hint: "This version only" }];
  const tasks = [
    { id: "document", label: "Edit current CV", panelId: "cv-document" },
    ...(history ? [{ id: "history" as const, label: "History", panelId: "cv-history" }] : []),
    ...(compare ? [{ id: "compare" as const, label: "Compare", panelId: "cv-compare" }] : []),
    ...(roleDetails ? [{ id: "role" as const, label: "Role details", panelId: "cv-role-details" }] : []),
  ] as const;
  return <CvContextLayout mode={mode} visible={view === "document"} chooseRefine={() => select("refine")}><div className="space-y-4">
    <TaskNavigation label="CV tasks" idPrefix="cv-task" items={tasks} active={view} onSelect={setView} />
    <div id="cv-document" role="tabpanel" aria-labelledby="cv-task-tab-document" hidden={view !== "document"}>
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
    </div>
    {history && <section id="cv-history" role="tabpanel" aria-labelledby="cv-task-tab-history" tabIndex={-1} hidden={view !== "history"}>{history}</section>}
    {compare && <section id="cv-compare" role="tabpanel" aria-labelledby="cv-task-tab-compare" tabIndex={-1} hidden={view !== "compare"}>{compare}</section>}
    {roleDetails && <section id="cv-role-details" role="tabpanel" aria-labelledby="cv-task-tab-role" tabIndex={-1} hidden={view !== "role"}>{roleDetails}</section>}
  </div></CvContextLayout>;
}
