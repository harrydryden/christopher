"use client";

import { lazy, Suspense, useState, type ComponentProps } from "react";
import type { CvLibraryEditor } from "./CvLibraryEditor";

const Editor = lazy(() => import("./CvLibraryEditor").then(module => ({ default: module.CvLibraryEditor })));

/** About and contact can be opened without loading the legacy evidence editor on first visit. */
export function CvAboutEditor(props: ComponentProps<typeof CvLibraryEditor>) {
  const [visited, setVisited] = useState(false);
  return <details className="border-t border-line-muted pt-3" onToggle={event => {
    if (event.currentTarget.open) setVisited(true);
  }}>
    <summary className="min-h-11 cursor-pointer text-16 font-semibold">About you and contact</summary>
    {visited && <div className="mt-3"><Suspense fallback={<p role="status" className="text-14 text-muted">Opening About you…</p>}><Editor {...props} careerManaged /></Suspense></div>}
  </details>;
}
