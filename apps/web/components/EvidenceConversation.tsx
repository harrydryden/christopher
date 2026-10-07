"use client";

import { useEffect, useRef, useState } from "react";
import type { EvidenceDraftInput } from "@col/core";
import { confirmEvidenceAnswerAsWritten, confirmEvidenceDraft, dismissEvidenceDraft, requestEvidenceDraft, retryEvidenceDraft, skipEvidenceQuestion, type EvidenceDraftView } from "@/app/actions/evidence";
import { buttonClass } from "@/components/Button";
import { inputClass } from "@/components/Field";

type Props = {
  question: string; questionId: string; destination: EvidenceDraftInput["destination"];
  baseVersion: number; source: EvidenceDraftInput["source"]; sourceId?: string | null;
  facet?: EvidenceDraftInput["facet"]; initialDraft?: EvidenceDraftView | null;
  disabled?: boolean; onConfirmed?: (wording: string) => void; scopeId: string; destinationLabel?: string;
};

/** One question, one answer, one proposed row, and a separate exact-wording confirmation. */
export function EvidenceConversation(props: Props) {
  const [answer, setAnswer] = useState(props.initialDraft?.answer ?? "");
  const [draft, setDraft] = useState<EvidenceDraftView | null>(props.initialDraft?.status === "dismissed" ? null : props.initialDraft ?? null);
  const [wording, setWording] = useState(props.initialDraft?.wording ?? props.initialDraft?.answer ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(props.initialDraft?.status === "dismissed");
  const [manualMode, setManualMode] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const wordingRef = useRef<HTMLTextAreaElement>(null);
  const wordingRevision = useRef(0);
  const localKey = `evidence-answer:${props.scopeId}:${props.source}:${props.sourceId ?? "library"}:${props.baseVersion}:${props.questionId}:${props.destination.kind}:${props.destination.id}`;
  const reviewKey = localKey.replace("evidence-answer:", "evidence-review:");
  const confirmedKey = localKey.replace("evidence-answer:", "evidence-confirmed:");
  const displayDraft = (draft || manualMode) && !done && !skipped;

  useEffect(() => {
    if (!props.initialDraft?.answer) {
      try { setAnswer(window.sessionStorage.getItem(localKey) ?? ""); } catch { /* Private browsing may disable session storage. */ }
    }
    try {
      const reviewed = window.sessionStorage.getItem(reviewKey);
      if (reviewed) { setWording(reviewed); setManualMode(true); wordingRevision.current++; }
      if (props.source === "cv_quiz") {
        const confirmed = window.sessionStorage.getItem(confirmedKey);
        if (confirmed) { setWording(confirmed); setDone(true); props.onConfirmed?.(confirmed); }
      }
    } catch { /* A server draft still provides the saved proposal. */ }
    setHydrated(true);
  // This instance has one scoped question and destination; restore once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localKey]);
  useEffect(() => {
    if (!hydrated) return;
    try { if (answer) window.sessionStorage.setItem(localKey, answer); else window.sessionStorage.removeItem(localKey); }
    catch { /* The in-memory answer still survives while this page is open. */ }
  }, [answer, localKey, hydrated]);
  useEffect(() => {
    if (!hydrated || !displayDraft || done) return;
    try { if (wording) window.sessionStorage.setItem(reviewKey, wording); else window.sessionStorage.removeItem(reviewKey); }
    catch { /* The review remains in memory for this visit. */ }
  }, [wording, reviewKey, hydrated, displayDraft, done]);

  useEffect(() => {
    if (!draft || draft.status !== "queued" || done || skipped) return;
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/evidence/drafts/${draft.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as Pick<EvidenceDraftView, "status" | "wording" | "error" | "attempt">;
        if (live && next.status !== "queued") {
          setDraft(current => current ? { ...current, ...next } : current);
          if (wordingRevision.current === 0) setWording(next.wording ?? answer);
        }
      } catch { /* A transient poll error leaves the answer and retry route available. */ }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    void poll();
    return () => { live = false; window.clearInterval(timer); };
  }, [draft?.id, draft?.status, answer, done, skipped]);

  async function request() {
    if (!answer.trim()) { setError("Add an answer first, or choose Nothing further."); answerRef.current?.focus(); return; }
    setBusy(true); setError("");
    try {
      const result = await requestEvidenceDraft({ source: props.source, sourceId: props.sourceId ?? null,
        questionId: props.questionId, question: props.question, answer, destination: props.destination,
        baseVersion: props.baseVersion, facet: props.facet ?? null });
      if (!result.ok) { setError(`${result.error} You can still review and save your answer as written.`); setManualMode(true); setWording(answer); return; }
      setDraft(result.draft); setWording(result.draft.wording ?? answer);
      window.setTimeout(() => wordingRef.current?.focus(), 0);
    } catch { setError("Could not prepare a draft. You can still review and save your answer as written."); setManualMode(true); setWording(answer); }
    finally { setBusy(false); }
  }

  async function retry() {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const result = await retryEvidenceDraft(draft.id);
      if (!result.ok) setError(result.error);
      else setDraft({ ...draft, status: "queued", error: null, wording: null, attempt: draft.attempt + 1 });
    } catch { setError("Could not retry the draft. Your answer is still here."); }
    finally { setBusy(false); }
  }

  async function confirm() {
    const exact = wording.trim();
    if (!exact) { setError("Review some wording before confirming it."); wordingRef.current?.focus(); return; }
    setBusy(true); setError("");
    if (props.source === "cv_quiz") {
      props.onConfirmed?.(exact);
      try { window.sessionStorage.setItem(confirmedKey, exact); } catch { /* The current form still holds it. */ }
      setDone(true); setBusy(false); return;
    }
    try {
      const result = draft ? await confirmEvidenceDraft(draft.id, exact) : await confirmEvidenceAnswerAsWritten({
        source: props.source, sourceId: props.sourceId ?? null, questionId: props.questionId,
        question: props.question, answer, destination: props.destination, baseVersion: props.baseVersion,
        facet: props.facet ?? null,
      }, exact);
      if (!result.ok) { setError(result.error); return; }
      props.onConfirmed?.(exact);
      setDone(true);
      try { window.sessionStorage.removeItem(localKey); window.sessionStorage.removeItem(reviewKey); } catch { /* Saved server-side. */ }
    } catch { setError("Could not save this wording. It is still here for you to retry."); }
    finally { setBusy(false); }
  }

  async function dismiss() {
    setBusy(true); setError("");
    try {
      const result = draft ? await dismissEvidenceDraft(draft.id) : await skipEvidenceQuestion({
        source: props.source, sourceId: props.sourceId ?? null, questionId: props.questionId,
        question: props.question, destination: props.destination, baseVersion: props.baseVersion,
        facet: props.facet ?? null,
      });
      if (!result.ok) { setError(result.error); return; }
      setDraft(null); setManualMode(false); setSkipped(true);
      try { window.sessionStorage.removeItem(reviewKey); window.sessionStorage.removeItem(confirmedKey); } catch { /* This visit still reflects the skip. */ }
    } catch { setError("Could not remember this choice. Your answer is still here."); }
    finally { setBusy(false); }
  }

  async function editAnswer() {
    setBusy(true); setError("");
    try {
      if (draft) {
        const result = await dismissEvidenceDraft(draft.id);
        if (!result.ok) { setError(result.error); return; }
      }
      setDraft(null); setManualMode(false); setWording(answer); wordingRevision.current = 0;
      try { window.sessionStorage.removeItem(reviewKey); } catch { /* State is still reset in memory. */ }
      window.setTimeout(() => answerRef.current?.focus(), 0);
    } catch { setError("Could not reopen the answer. Your text is still here."); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 border-t border-line-muted pt-4" aria-label="Evidence question">
    <p className="ds-prose text-16 font-medium">{props.question}</p>
    {done ? <p role="status" className="text-14 text-ok">{props.source === "library" ? "Saved to Experience." : "Wording confirmed for this CV question. Save evidence and continue when ready."}</p>
      : skipped ? <div className="space-y-2"><p role="status" className="text-14 text-muted">Nothing further for this question.</p><button type="button" className="text-14 underline" onClick={() => { setSkipped(false); window.setTimeout(() => answerRef.current?.focus(), 0); }}>Return to this question</button></div>
      : <>
        <label className="block space-y-1.5"><span className="text-12 font-semibold">Your answer</span>
          <textarea ref={answerRef} rows={4} maxLength={2000} className={`ds-prose ${inputClass}`} value={answer}
            disabled={!!displayDraft || busy || props.disabled} onChange={event => setAnswer(event.target.value)}
            placeholder="Describe what happened, what you did, and the result in your own words." />
        </label>
        {!displayDraft ? <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={buttonClass("primary")} disabled={busy || props.disabled} onClick={() => void request()}>{busy ? "Preparing…" : "Review an evidence draft"}</button>
          <button type="button" className="text-14 underline" disabled={busy || props.disabled || !answer.trim()} onClick={() => { wordingRevision.current++; setWording(answer); setManualMode(true); }}>Use my answer as written</button>
          <button type="button" className="text-14 underline" disabled={busy} onClick={() => void dismiss()}>Nothing further</button>
          {answer && <button type="button" className="text-14 text-muted underline" disabled={busy} onClick={() => { setAnswer(""); setError(""); }}>Discard answer</button>}
        </div> : <div className="space-y-3 border-l-2 border-accent pl-4">
          <div><p className="text-12 font-semibold">Proposed wording</p><p className="text-12 text-muted">Your original answer is above. Edit the wording before you confirm it.</p></div>
          {draft?.status === "queued" && <p role="status" className="text-14">Preparing a draft… You can use your answer as written now.</p>}
          {draft?.status === "failed" && <p role="status" className="text-14 text-warn">{draft.error ?? "A draft was unavailable."}</p>}
          <label className="block space-y-1.5"><span className="text-12 font-semibold">Wording to save</span>
            <textarea ref={wordingRef} rows={4} maxLength={2000} className={`ds-prose ${inputClass}`} value={wording}
              onChange={event => { wordingRevision.current++; setWording(event.target.value); }} disabled={busy || props.disabled} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass("primary")} disabled={busy || props.disabled} onClick={() => void confirm()}>{busy ? "Saving…" : props.source === "library" ? `Confirm and save to ${props.destinationLabel ?? "Experience"}` : `Confirm for ${props.destinationLabel ?? "this CV question"}`}</button>
            <button type="button" className="text-14 underline" disabled={busy || props.disabled} onClick={() => { wordingRevision.current++; setWording(answer); }}>Use my answer as written</button>
            {draft?.status === "failed" && <button type="button" className="text-14 underline" disabled={busy || props.disabled} onClick={() => void retry()}>Retry draft</button>}
            <button type="button" className="text-14 underline" disabled={busy} onClick={() => void editAnswer()}>Edit my answer</button>
            <button type="button" className="text-14 underline" disabled={busy} onClick={() => void dismiss()}>Nothing further</button>
          </div>
        </div>}
      </>}
    {error && <p role="alert" className="text-14 text-danger">{error}</p>}
  </section>;
}
