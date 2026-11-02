"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { selectCvEdition } from "@/app/actions/cv-editing";

/** History selection is deliberate; a background build never chooses an edition for the person. */
export function CvSelectEdition({ contextId, kind, id, label }: {
  contextId: string; kind: "baseline" | "draft"; id: string; label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function select() {
    if (pending) return;
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Select another saved edition? Your unsaved wording remains on this page, but the selected edition will change.")) return;
    setPending(true); setError(null);
    try {
      const result = await selectCvEdition(contextId, kind, id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch { setError("Could not select this saved edition. Please try again."); }
    finally { setPending(false); }
  }
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" className="min-h-11 border border-line-muted px-3 text-14" disabled={pending} onClick={select}>
      {pending ? "Selecting…" : label}
    </button>
    {error && <span role="alert" className="text-12 text-danger">{error}</span>}
  </span>;
}
