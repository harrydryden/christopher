"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { openCvAutoEdition, openOrClaimAutoCv } from "@/app/actions/cv-editing";
import { CvSelectEdition } from "./CvSelectEdition";
import { CvFinaliseControl } from "./CvFinaliseControl";
import { CvCheckForm } from "./CvCheckForm";

type Baseline = { id: string; status: "queued" | "ready" | "failed"; sourceDraftId: string | null;
  rendererCurrent?: boolean };

export function CvAutoMode({ contextId, selectedBaseline, baselines, summary }: {
  contextId: string; selectedBaseline: Baseline | null;
  baselines: Array<Baseline & { publishedAt: string | null }>;
  summary: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ baselineId: string; id: string; revision: number; baseHash: string } | null>(null);
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
        setOpened({ baselineId: selectedBaseline.id, id: result.draftId,
          revision: result.revision, baseHash: result.baseHash });
        setNotice("Review this saved wording. Check is optional before final approval."); router.refresh();
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
        onClick={useSavedBaseline}>Review and finalise this Auto CV · free</button>
      {opened?.baselineId === selectedBaseline.id && <div className="space-y-3 border-t border-line-muted pt-3">
        <CvCheckForm id={opened.id} hasContent />
        <CvFinaliseControl id={opened.id} revision={opened.revision} baseHash={opened.baseHash} />
      </div>}
    </div> : selectedBaseline?.status === "queued" ? <p role="status">Auto is building. Your selected edition will not change when it finishes.</p>
      : <p>No ready Auto result is selected for this application.</p>}
    <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending} onClick={update}>
      {pending ? "Checking current inputs…" : selectedBaseline ? "Update Auto from current inputs" : "Create Auto CV"}
    </button>
    <p className="text-12 text-muted">A saved result is free; generating a new Auto CV uses one CV credit. Refine and Manual edits stay separate.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {baselines.some(row => row.id !== selectedBaseline?.id) && <details><summary className="cursor-pointer">Other Auto results</summary>
      <ul className="mt-2 space-y-2">{baselines.filter(row => row.id !== selectedBaseline?.id).map(row => <li key={row.id}>
        <CvSelectEdition contextId={contextId} kind="baseline" id={row.id} label="Select this Auto result" />
        {row.status === "ready" ? <a className="underline" href={`/api/cv/baseline/${row.id}/pdf`} target="_blank" rel="noopener noreferrer">Open saved Auto PDF</a>
          : <span>{row.status === "queued" ? "Building" : "Failed"}</span>}
        {row.publishedAt && <span className="ml-2 text-12 text-muted">{new Date(row.publishedAt).toLocaleDateString("en-GB")}</span>}
      </li>)}</ul>
    </details>}
  </div>;
}
