"use client";

import { useState } from "react";
import type { CvEvaluationRow } from "@/lib/cv-evaluation";
import type { CvReviewDecision } from "@col/core/cv-review";
import { dismissCvReviewItem, finaliseCvDraft } from "@/app/actions/cv";
import { SettingsForm } from "./SettingsForm";
import { CvContentBlockLink } from "./CvWorkspace";
import type { ActionResult } from "@/lib/action-result";

/** An assessment finding stays visible after dismissal; dismissal is a user choice, not verification. */
export function CvReviewControls({ id, rows, decision, factualRowIds, assessmentHash, assessedAt, canFinalise }: {
  id: string;
  rows: CvEvaluationRow[];
  decision: CvReviewDecision | null;
  factualRowIds: string[];
  assessmentHash: string;
  assessedAt: string;
  canFinalise: boolean;
}) {
  const findings = rows.filter((row) => row.change !== "None" && row.change !== "Comment");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>(decision?.dismissedRowIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = findings[Math.min(selected, findings.length - 1)];
  const remainingFacts = factualRowIds.filter((rowId) => !dismissed.includes(rowId));

  async function dismiss() {
    if (!item || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await dismissCvReviewItem(id, item.id, assessmentHash, assessedAt);
      if (!result.ok) { setError(result.error); return; }
      setDismissed((items) => [...new Set([...items, item.id])]);
      setSelected((index) => Math.min(index + 1, findings.length - 1));
    } catch {
      setError("Could not save this choice. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function finalise(previous: ActionResult, form: FormData): Promise<ActionResult> {
    if (document.querySelector('[data-cv-editor-dirty="true"]'))
      return { ok: false, error: "You have unsaved CV edits. Save and reassess them, or reload this page before finalising the saved revision." };
    return finaliseCvDraft(id, previous, form);
  }

  return <div className="space-y-4" id="cv-guided-review" tabIndex={-1}>
    {findings.length > 0 && <section className="space-y-3 border border-warn p-4" aria-labelledby="cv-review-heading">
      <div>
        <h3 id="cv-review-heading" className="ds-pixel text-11">Review flagged items</h3>
        <p className="text-12 text-muted">Read each finding, edit the saved wording or evidence if you can, or choose “Nothing further to add”. Dismissed findings remain in the evaluation and do not become verified facts.</p>
      </div>
      <div role="group" aria-label="Choose a flagged item" className="flex flex-wrap gap-2">
        {findings.map((row, index) => <button key={row.id} type="button" aria-pressed={index === selected}
          onClick={() => setSelected(index)}
          className={`border px-2 py-1 text-12 ${index === selected ? "border-accent bg-accent text-accent-fg" : "border-line-muted"}`}>
          Item {index + 1} · {row.change}{dismissed.includes(row.id) ? " · Dismissed" : ""}
        </button>)}
      </div>
      {item && <div className="space-y-2 bg-sunken p-3" aria-live="polite">
        <p className="text-12 font-semibold">Item {selected + 1} of {findings.length} · {item.change} · {item.requirement}</p>
        {item.currentText.map((text, index) => <p key={index} className="text-14"><em>{text}</em></p>)}
        <p className="text-14">{item.suggestion}</p>
        {item.sources.length > 0 && <p className="text-12 text-muted">Saved evidence: {item.sources.join(" · ")}</p>}
        <div className="flex flex-wrap items-center gap-3 text-12">
          {item.contentLinks.length > 0 ? item.contentLinks.map((link) => <CvContentBlockLink key={link.id} id={link.id}>Edit {link.label}</CvContentBlockLink>) : <CvContentBlockLink>Open Content</CvContentBlockLink>}
          {item.libraryHref && <a className="underline" href={item.libraryHref} onClick={(event) => {
            if (document.querySelector('[data-cv-editor-dirty="true"]')) {
              event.preventDefault();
              setError("Save your CV edits before leaving for the Library.");
            }
          }}>Add evidence for this</a>}
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" disabled={selected === 0} onClick={() => setSelected((value) => value - 1)} className="border border-line-muted px-3 py-1.5 text-12 disabled:opacity-50">Previous</button>
          <button type="button" disabled={selected === findings.length - 1} onClick={() => setSelected((value) => value + 1)} className="border border-line-muted px-3 py-1.5 text-12 disabled:opacity-50">Next</button>
          <button type="button" disabled={saving || dismissed.includes(item.id)} onClick={dismiss} className="border border-warn px-3 py-1.5 text-12 disabled:opacity-50">{dismissed.includes(item.id) ? "Nothing further to add · saved" : saving ? "Saving…" : "Nothing further to add"}</button>
        </div>
      </div>}
      {error && <p role="alert" className="text-12 text-danger">{error}</p>}
    </section>}
    {canFinalise && <SettingsForm action={finalise} submitLabel="Finalise this CV" submitDisabled={remainingFacts.length > 0}
      secondaryActions={remainingFacts.length > 0 ? <button type="submit" name="skipReview" value="on" className="border border-warn px-3 py-2 text-12 font-medium">Skip review and finalise anyway</button> : undefined}>
      <label className="text-14"><input name="reviewed" type="checkbox" required /> I confirm this saved CV is the version I want to finalise, including any unresolved findings.</label>
      <input name="assessmentHash" type="hidden" value={assessmentHash} />
      <input name="assessedAt" type="hidden" value={assessedAt} />
      {remainingFacts.length > 0 && <p className="text-12 text-warn">{remainingFacts.length} factual {remainingFacts.length === 1 ? "finding is" : "findings are"} still open. You can dismiss each one or explicitly finalise anyway. The findings and score remain unchanged.</p>}
    </SettingsForm>}
  </div>;
}
