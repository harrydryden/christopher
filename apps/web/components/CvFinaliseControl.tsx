"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveCvFinalisation, prepareCvFinalisation } from "@/app/actions/cv-finalisation";

type Prepared = Extract<Awaited<ReturnType<typeof prepareCvFinalisation>>, { ok: true }>;

/** Approval is a separate, deliberate step after measuring the current saved PDF. */
export function CvFinaliseControl({ id, revision, baseHash }: { id: string; revision: number; baseHash: string }) {
  const router = useRouter();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dirty = () => [...document.querySelectorAll<HTMLElement>('[data-cv-editor-dirty="true"], [data-cv-mode-dirty="true"]')]
    .some(editor => editor.dataset.cvEditorId === id || editor.dataset.cvModeEditorId === id);

  async function prepare() {
    if (pending) return;
    if (dirty()) { setError("Save your CV edits before reviewing the final PDF."); return; }
    setPending(true); setError(null); setPrepared(null); setAcknowledged(false);
    try {
      const result = await prepareCvFinalisation(id, revision, baseHash);
      if (result.ok) setPrepared(result);
      else setError(result.error);
    } catch { setError("Could not prepare the final PDF. Please try again."); }
    finally { setPending(false); }
  }

  async function approve() {
    if (!prepared || pending || !acknowledged) return;
    if (dirty()) { setError("Save your CV edits and review the final PDF again."); setPrepared(null); return; }
    setPending(true); setError(null);
    try {
      const result = await approveCvFinalisation(id, prepared.token, acknowledged);
      if (result.ok) { setDone(true); router.refresh(); }
      else { setError(result.error); setPrepared(null); }
    } catch { setError("Could not confirm finalisation. Reload this CV and check whether its PDF was saved."); }
    finally { setPending(false); }
  }

  return <section className="space-y-3 border border-line-muted p-3" aria-label="Finalise saved CV">
    <div>
      <p className="text-14 font-semibold">Finalise this saved CV</p>
      <p className="text-12 text-muted">Checking is optional. Final approval measures and stores this exact PDF; it does not rewrite your wording or use a CV credit.</p>
    </div>
    {!prepared && !done && <button type="button" className="min-h-11 border border-line-muted px-4 text-14" disabled={pending} onClick={prepare}>
      {pending ? "Measuring PDF…" : "Review final PDF and warnings"}
    </button>}
    {prepared && !done && <div className="space-y-3">
      <p className="text-14">Measured PDF: <strong>{prepared.measuredPages} {prepared.measuredPages === 1 ? "page" : "pages"}</strong> · chosen limit {prepared.maxPages} · {prepared.assessmentState === "current" ? "current Check" : prepared.assessmentState === "stale" ? "Check out of date" : "not checked"}</p>
      <a className="text-14 underline" href={`/api/cv/${id}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Open this saved revision’s PDF</a>
      {prepared.warnings.length > 0 ? <div className="border border-warn p-3 text-14">
        <p className="font-semibold">Warnings to acknowledge</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{prepared.warnings.map(warning => <li key={warning.id}>{warning.text}</li>)}</ul>
      </div> : <p className="text-14">No finalisation warnings were found.</p>}
      <label className="flex min-h-11 items-center gap-2 text-14"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> I have reviewed this saved PDF and its warnings and choose to finalise it.</label>
      <button type="button" className="min-h-11 border border-line-muted px-4 text-14" disabled={!acknowledged || pending} onClick={approve}>{pending ? "Finalising…" : "Finalise this CV"}</button>
    </div>}
    {done && <p role="status" className="text-14">Finalised. The saved PDF is now available.</p>}
    {error && <p role="alert" className="text-14 text-danger">{error}</p>}
  </section>;
}
