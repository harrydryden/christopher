"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvContent } from "@col/core/cv";
import { readCvSkillSuggestions, requestCvSkillSuggestions, type CvSkillSuggestionsResult } from "@/app/actions/cv";
import { useCvSkillSuggestions } from "@/app/actions/cv-skills";

type Quote = { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
type Run = Extract<CvSkillSuggestionsResult, { ok: true }>["run"];

/** Proposals are CV-only until selected; Use records verified skill tags in Experience and this CV. */
export function CvModeSkillSuggestions({ contextId, draftId, revision, overlayVersion, content, libraryVersion, quote }: {
  contextId: string; draftId: string | null; revision: number | null; overlayVersion: number;
  content: CvContent | null; libraryVersion: number | null; quote: Quote | null;
}) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  useEffect(() => { setRun(null); setSelected([]); key.current = null; }, [draftId, revision]);
  useEffect(() => {
    if (!draftId || !run || !["queued", "running"].includes(run.status)) return;
    let live = true;
    const timer = window.setInterval(() => { void readCvSkillSuggestions(draftId, run.id).then(result => {
      if (live && result.ok) { setRun(result.run); if (result.run.status !== "queued" && result.run.status !== "running") router.refresh(); }
    }).catch(() => {}); }, 3_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [draftId, run?.id, run?.status, router]);
  async function generate() {
    if (!draftId || revision === null || !content || !quote || pending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await requestCvSkillSuggestions(draftId, !!run, libraryVersion ?? undefined, content, revision, quote);
      if (!result.ok) { setError(result.error); router.refresh(); return; }
      setRun(result.run); setSelected([]); key.current = null; router.refresh();
    } catch { setError("Could not request skill suggestions. Your CV is unchanged."); }
    finally { setPending(false); }
  }
  async function useSelected() {
    if (!draftId || revision === null || !run || run.status !== "ready" || !selected.length || pending) return;
    if (!key.current) key.current = crypto.randomUUID();
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await useCvSkillSuggestions(contextId, draftId, run.id, revision, overlayVersion, selected, key.current);
      if (!result.ok) { setError(result.error); return; }
      key.current = null; setSelected([]);
      setNotice("Selected skills saved to Experience and the current CV."); router.refresh();
    } catch { setError("Could not save the selected skills. Your choices remain here."); }
    finally { setPending(false); }
  }
  return <section aria-label="Skill suggestions" className="space-y-3 border border-line-muted p-3 text-14">
    <h3 className="font-semibold">Skills for this role</h3>
    <button type="button" className="min-h-11 border border-line-muted px-3" disabled={!draftId || !content || !quote || pending}
      onClick={() => void generate()}>{pending ? "Working…" : run ? "Refresh skill suggestions" : "Generate skills"}</button>
    {quote && <p className="text-12 text-muted">{quote.charge === "role_credit" ? "1 role credit" : `${quote.units} AI units`}</p>}
    {!draftId && <p className="text-13 text-muted">Select a saved CV edition before generating skills.</p>}
    {run && ["queued", "running"].includes(run.status) && <p role="status">Checking saved Experience for supported skills…</p>}
    {run?.status === "failed" && <p role="alert">{run.error ?? "Skill suggestions could not be prepared."}</p>}
    {run?.status === "ready" && <><fieldset disabled={pending} className="space-y-2"><legend className="font-medium">Choose skills</legend>
      {run.suggestions.length ? run.suggestions.map(item => <label key={item.id} className="flex min-h-11 items-start gap-2">
        <input type="checkbox" checked={selected.includes(item.id)} onChange={event => {
          key.current = null; setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id));
        }} /><span><strong>{item.label}</strong> · {item.category}<span className="block text-12 text-muted">From Experience: {item.evidenceQuote}</span></span>
      </label>) : <p>No additional supported skills were found.</p>}</fieldset>
      {run.suggestions.length > 0 && <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !selected.length}
        onClick={() => void useSelected()}>Save selected skills to Experience and CV · free</button>}</>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
