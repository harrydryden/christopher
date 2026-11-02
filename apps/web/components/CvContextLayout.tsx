"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CvTheme } from "@col/core/cv-theme-values";
import type { CvEditingMode } from "@col/core/cv-editing-modes";
import { CvAppearance } from "./CvAppearance";

type Registration = { mode: CvEditingMode; theme: CvTheme; change: (theme: CvTheme) => void;
  remember?: () => void; pending?: boolean };
const LayoutContext = createContext<((mode: CvEditingMode, registration: Registration | null) => void) | null>(null);

/** The mode owns its unsaved appearance; this panel only edits that mounted buffer. */
export function useCvContextLayout(mode: CvEditingMode, theme: CvTheme | null | undefined,
  change: (theme: CvTheme) => void, remember?: () => void, pending = false) {
  const register = useContext(LayoutContext);
  const latest = useRef({ change, remember, pending });
  latest.current = { change, remember, pending };
  useEffect(() => {
    if (!register || !theme) return;
    register(mode, { mode, theme, change: next => latest.current.change(next),
      remember: remember ? () => latest.current.remember?.() : undefined,
      pending: latest.current.pending });
    return () => register(mode, null);
  }, [register, mode, theme, !!remember, pending]);
}

export function CvContextLayout({ mode, children, chooseRefine }: {
  mode: CvEditingMode; children: ReactNode; chooseRefine: () => void;
}) {
  const [registered, setRegistered] = useState<Partial<Record<CvEditingMode, Registration>>>({});
  const register = useCallback((key: CvEditingMode, next: Registration | null) => {
    setRegistered(previous => {
      if (previous[key] === next || (!previous[key] && !next)) return previous;
      const updated = { ...previous };
      if (next) updated[key] = next; else delete updated[key];
      return updated;
    });
  }, []);
  const active = registered[mode] ?? null;
  return <LayoutContext.Provider value={register}>
    {children}
    <details id="cv-context-layout" className="border border-line-muted p-4 text-14">
      <summary className="cursor-pointer font-semibold">Layout and PDF</summary>
      {active ? <div className="mt-3 space-y-3">
        <fieldset disabled={active.pending}><CvAppearance value={active.theme} onChange={active.change} /></fieldset>
        {mode === "manual" ? <p className="text-12 text-muted">Save Manual to keep this layout with its wording.</p>
          : <button type="button" className="min-h-11 border border-line-muted px-4" disabled={active.pending}
            onClick={active.remember}>Remember this layout for this role · free</button>}
      </div> : <div className="mt-3 space-y-2"><p className="text-12 text-muted">Auto keeps its saved layout.</p>
        <button type="button" className="min-h-11 border border-line-muted px-4" onClick={chooseRefine}>Customise Layout in Refine</button></div>}
    </details>
  </LayoutContext.Provider>;
}
