"use client";

import dynamic from "next/dynamic";
import { useState, type ComponentProps } from "react";
import type { CvLibraryEditor } from "./CvLibraryEditor";

const Editor = dynamic<ComponentProps<typeof CvLibraryEditor>>(
  () => import("./CvLibraryEditor").then(module => module.CvLibraryEditor),
  { loading: () => <p role="status" className="text-14 text-muted">Opening About you…</p> });

/** About and contact can be opened without loading the legacy evidence editor on first visit. */
export function CvAboutEditor(props: ComponentProps<typeof CvLibraryEditor>) {
  const [visited, setVisited] = useState(false);
  return <details className="border-t border-line-muted pt-3" onToggle={event => {
    if (event.currentTarget.open) setVisited(true);
  }}>
    <summary className="min-h-11 cursor-pointer text-16 font-semibold">About you and contact</summary>
    {visited && <div className="mt-3"><Editor {...props} careerManaged /></div>}
  </details>;
}
