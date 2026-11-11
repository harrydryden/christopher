"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { openCvAutoEdition, openOrClaimAutoCv, readAutoCvSourceChoices } from "@/app/actions/cv-editing";
import type { CareerCvChoiceOverride, CareerCvProjection } from "@col/core/career-record";

type Baseline = { id: string; status: "queued" | "ready" | "failed"; sourceDraftId: string | null;
  rendererCurrent?: boolean };

export function CvAutoMode({ contextId, selectedBaseline, knownLibraryDrift = false, knownRoleDrift = false,
  initialChoices = [], quote }: {
  contextId: string; selectedBaseline: Baseline | null;
  knownLibraryDrift?: boolean; knownRoleDrift?: boolean;
  initialChoices?: CareerCvChoiceOverride[];
  quote?: { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceReview, setSourceReview] = useState<CareerCvProjection["reviewConflicts"] | null>(null);
  const [choiceDraft, setChoiceDraft] = useState<CareerCvChoiceOverride[] | null>(null);
  const [choicesOpen, setChoicesOpen] = useState(false);
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const choices = choiceDraft ?? initialChoices;
  async function loadChoices() {
    if (loadingChoices || pending) return;
    setChoicesOpen(true); setLoadingChoices(true); setChoicesError(null);
    try {
      const result = await readAutoCvSourceChoices(contextId);
      if (result.ok) setSourceReview(result.conflicts);
      else setChoicesError(result.error);
    } catch { setChoicesError("Could not load Experience choices. Your selections are unchanged."); }
    finally { setLoadingChoices(false); }
  }
  function choose(group: CareerCvProjection["reviewConflicts"][number], chosenAssertionId: string) {
    setChoiceDraft([...choices.filter(choice => choice.groupKey !== group.groupKey),
      ...(chosenAssertionId ? [{ groupKey: group.groupKey, fingerprint: group.fingerprint, chosenAssertionId }] : [])]);
  }
  async function update() {
    if (pending || loadingChoices) return;
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Update Auto while another mode has unsaved wording? Your text remains on this page, but the selected edition may change.")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await openOrClaimAutoCv(contextId, "update", choices, quote);
      if (result.sourceReview) {
        setSourceReview(result.sourceReview);
        if (result.sourceReview.length) setChoicesOpen(true);
      }
      if (!result.ok) setError(result.error);
      else {
        setNotice(result.status === "ready" ? "Your saved Auto CV is ready. No new AI usage was charged."
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
        setNotice("This saved Auto CV is selected. Feedback and final approval use this edition."); router.refresh();
      }
    } catch { setError("Could not open this Auto edition. Please try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-4 border border-line-muted p-4 text-14">
    <div>
      <h2 className="font-semibold">Auto CV</h2>
    </div>
    {selectedBaseline?.status === "ready" ? <div className="space-y-3 border border-line-muted p-3">
      <p>Saved Auto result available.</p>
      {selectedBaseline.rendererCurrent === false && <p className="text-12 text-warn">This Auto PDF used an earlier layout. Update Auto or fork a new edition to review it with the current layout.</p>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending}
        onClick={useSavedBaseline}>Select Auto for Feedback and approval · free</button>
    </div> : selectedBaseline?.status === "queued" ? <p role="status">Auto is building. Your selected edition will not change when it finishes.</p>
      : <p>No ready Auto result is selected for this application.</p>}
    {(knownLibraryDrift || knownRoleDrift) && <p role="status" className="border border-warn p-3 text-12 text-warn">
      {knownRoleDrift && "The saved role description has changed. "}
      {knownLibraryDrift && "Your Experience has changed. "}
      Update Auto only when you want a new result from the current inputs; the selected saved CV stays available.
    </p>}
    {!choicesOpen && <button type="button" className="min-h-11 underline" disabled={pending}
      onClick={() => { if (sourceReview === null && !choicesError) void loadChoices(); else setChoicesOpen(true); }}>
      Sources and Experience choices{choices.length ? ` · ${choices.length}` : ""}
    </button>}
    {choicesOpen && <section aria-label="Sources and Experience choices" className="space-y-2">
      <button type="button" className="min-h-11 underline" onClick={() => setChoicesOpen(false)}>Back to Auto CV</button>
      <h3 className="font-medium">Sources and Experience choices</h3>
      <div className="space-y-3 border border-line-muted p-3">
        {loadingChoices && <p role="status">Loading choices…</p>}
        {sourceReview?.map(group => <fieldset key={group.conflictId} disabled={pending || loadingChoices} className="min-w-0 border border-line-muted p-3">
          <legend className="px-1 font-semibold">{group.title}</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name={`cv-source-${group.conflictId}`} value=""
              checked={!choices.some(choice => choice.groupKey === group.groupKey && choice.fingerprint === group.fingerprint)}
              onChange={() => choose(group, "")} />Leave these details out
          </label>
          {group.statements.map(statement => <label key={statement.id} className="flex min-h-11 items-center gap-2 py-2">
            <input type="radio" name={`cv-source-${group.conflictId}`} value={statement.id}
              checked={choices.some(choice => choice.groupKey === group.groupKey && choice.fingerprint === group.fingerprint && choice.chosenAssertionId === statement.id)}
              onChange={() => choose(group, statement.id)} />
            <span className="min-w-0 break-words">{statement.text}</span>
          </label>)}
          <a className="inline-flex min-h-11 items-center text-12 underline" href={`/library/review?conflict=${encodeURIComponent(group.conflictId)}`} target="_blank" rel="noreferrer">Review in Experience ↗</a>
        </fieldset>)}
        {sourceReview?.length === 0 && <p className="text-12">No disputed details need a choice for this build.</p>}
        {sourceReview && choices.some(choice => !sourceReview.some(group => group.groupKey === choice.groupKey && group.fingerprint === choice.fingerprint)) &&
          <p role="status" className="text-12 text-warn">Some saved choices no longer match this list. Choose a replacement or reset CV-only choices before building again.</p>}
        {choicesError && <p role="alert" className="text-danger">{choicesError}</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" className="min-h-11 underline" disabled={pending || loadingChoices} onClick={loadChoices}>Refresh choices</button>
          {choices.length > 0 && <button type="button" className="min-h-11 underline" disabled={pending || loadingChoices}
            onClick={() => setChoiceDraft([])}>Reset CV-only choices</button>}
        </div>
      </div>
    </section>}
    <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || loadingChoices} onClick={update}>
      {pending ? "Checking current inputs…" : selectedBaseline ? "Update Auto from current inputs" : "Create Auto CV"}
    </button>
    {quote && <p className="text-12 text-muted">New AI work: {quote.charge === "role_credit"
      ? "1 role credit for the first successful result" : `${quote.units} AI units`}. Reopening a saved result is free.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
