"use client";
import { useEffect, useState } from "react";
import { dismissLibraryImport } from "@/app/actions/library-import";
import { LIBRARY_IMPORT_SLOW_MS } from "@/lib/library-import-clock";
import { LibraryImportForm } from "./LibraryImportForm";

/** A row can become stalled without a database change, so this one card keeps its own clock. */
export function LibraryImportReading({ id, createdAtMs, initialStalled }: {
  id: string;
  createdAtMs: number;
  initialStalled: boolean;
}) {
  const [stalled, setStalled] = useState(initialStalled);
  useEffect(() => {
    const left = createdAtMs + LIBRARY_IMPORT_SLOW_MS - Date.now();
    if (left <= 0) {
      setStalled(true);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), left);
    return () => window.clearTimeout(timer);
  }, [createdAtMs]);
  if (!stalled) return <p role="status" className="text-14 text-muted">Reading your document (a minute or two)…</p>;
  return <div className="grid gap-3">
    <p role="status" className="text-14 text-warn">This is taking longer than usual. Dismiss it to import it again.</p>
    <LibraryImportForm
      action={dismissLibraryImport.bind(null, id)}
      submitLabel="Dismiss"
      pendingLabel="Dismissing…"
      className="contents"
      variant="ghost"
    />
  </div>;
}
