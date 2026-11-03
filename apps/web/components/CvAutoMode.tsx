"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { openCvAutoEdition, openOrClaimAutoCv } from "@/app/actions/cv-editing";

type Baseline = { id: string; status: "queued" | "ready" | "failed"; sourceDraftId: string | null;
  rendererCurrent?: boolean };

export function CvAutoMode({ contextId, selectedBaseline, summary, knownLibraryDrift = false, knownRoleDrift = false }: {
  contextId: string; selectedBaseline: Baseline | null;
  summary: ReactNode;
  knownLibraryDrift?: boolean; knownRoleDrift?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function update() {
    if (pending) return;
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Update Auto while another mode has unsaved wording? Your text remains on this page, but the selected edition may change.")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await openOrClaimAutoCv(contextId, "update");
      if (!result.ok) setError(result.error);
      else {
        setNotice(result.status === "ready" ? "Your saved Auto CV is ready. No new CV credit was used."
          : result.status === "queued" ? "Auto is building. Your current selection remains available while it runs."
            : "Auto could not start. Your saved editions remain available.");
        router.refresh();
      }
    } catch { setError("Could not update Auto. Your saved editions remain available."); }
    finally { setPending(false); }
  }
  async function useSavedBaseline() {
    if (!selectedBaseline || selectedBaseline.status !== "ready" || pending) return;
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Select this saved Auto result? Unsaved wording in another mode remains on this page, but the selected edition will change.")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await openCvAutoEdition(contextId, selectedBaseline.id);
      if (!result.ok) setError(result.error);
      else {
        setNotice("This saved Auto CV is selected. Feedback and final approval are below; Check is optional."); router.refresh();
      }
    } catch { setError("Could not open this Auto edition. Please try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-4 border border-line-muted p-4 text-14">
    <div>
      <h2 className="font-semibold">Auto CV</h2>
      <p className="text-12 text-muted">Build from Experience and this role. Reopening the saved result is free.</p>
    </div>
    {selectedBaseline?.status === "ready" ? <div className="space-y-3 border border-line-muted p-3">
      {summary}
      {selectedBaseline.rendererCurrent !== false ? <a className="inline-flex min-h-11 items-center underline" target="_blank" rel="noopener noreferrer"
        href={`/api/cv/baseline/${selectedBaseline.id}/pdf`}>Open selected Auto PDF</a>
        : <p className="text-12 text-warn">This Auto PDF used an earlier layout. Update Auto or fork a new edition to review it with the current layout.</p>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending}
        onClick={useSavedBaseline}>Select Auto for Feedback and approval · free</button>
    </div> : selectedBaseline?.status === "queued" ? <p role="status">Auto is building. Your selected edition will not change when it finishes.</p>
      : <p>No ready Auto result is selected for this application.</p>}
    {(knownLibraryDrift || knownRoleDrift) && <p role="status" className="border border-warn p-3 text-12 text-warn">
      {knownRoleDrift && "The saved role description has changed. "}
      {knownLibraryDrift && "Your Experience has changed. "}
      Update Auto only when you want a new result from the current inputs; the selected saved CV stays available.
    </p>}
    <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending} onClick={update}>
      {pending ? "Checking current inputs…" : selectedBaseline ? "Update Auto from current inputs" : "Create Auto CV"}
    </button>
    <p className="text-12 text-muted">A saved result is free; generating a new Auto CV uses one CV credit. Refine and Manual edits stay separate.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
