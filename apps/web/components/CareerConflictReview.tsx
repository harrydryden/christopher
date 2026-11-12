"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CareerAssertionContext, CareerConflictDecisionInput, CareerConflictDecisionResult,
  CareerConflictDetail } from "@col/core/career-record";
import { buttonClass } from "./Button";
import { inputClass, labelClass } from "./Field";

type Statement = CareerConflictDetail["statements"][number];
type Edit = NonNullable<CareerConflictDecisionInput["edits"]>[number];
type Choice = CareerConflictDecisionInput["choice"];

const sourceLabel = (statement: Statement) => statement.provenance.kind === "direct_user" ? "Added by you"
  : statement.provenance.kind === "document" ? "From an imported document"
    : statement.provenance.kind === "legacy_saved" ? "From earlier Experience" : "Suggestion";
const initialEdit = (statement: Statement): Edit => ({ id: statement.id, expectedRevision: statement.revision,
  text: statement.text, publicText: statement.publicText, facets: statement.facets, context: statement.context });

function ContextFields({ edit, onChange, prefix, disabled }: { edit: Edit; onChange: (next: Edit) => void; prefix: string; disabled: boolean }) {
  const context = edit.context ?? { attribute: "", scope: "", period: null, value: "" };
  function setContext(key: keyof NonNullable<CareerAssertionContext>, value: string) {
    onChange({ ...edit, context: { ...context, [key]: key === "period" ? value || null : value } });
  }
  return <div className="grid gap-3 sm:grid-cols-2">
    {(["attribute", "scope", "period", "value"] as const).map(key => <div key={key}>
      <label htmlFor={`${prefix}-${key}`} className={labelClass}>{({ attribute: "Detail", scope: "Scope", period: "Period (optional)", value: "Value" })[key]}</label>
      <input id={`${prefix}-${key}`} className={inputClass} value={context[key] ?? ""} disabled={disabled} maxLength={key === "period" ? 40 : key === "value" ? 200 : 120}
        onChange={event => setContext(key, event.target.value)} required={key !== "period"} />
    </div>)}
  </div>;
}

/** Decisions are saved separately from editing the main Experience record. */
export function CareerConflictReview({ detail: incoming, decide }: { detail: CareerConflictDetail;
  decide: (input: CareerConflictDecisionInput) => Promise<CareerConflictDecisionResult> }) {
  const router = useRouter();
  const [detail, setDetail] = useState(incoming);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [selectedId, setSelectedId] = useState(detail.statements[0]?.id ?? "");
  const [edits, setEdits] = useState<Record<string, Edit>>(() => Object.fromEntries(detail.statements.map(row => [row.id, initialEdit(row)])));
  const [pending, setPending] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedIntent = useRef<{ signature: string; key: string } | null>(null);
  const savedChoice = useRef<Choice | null>(null);
  const changed = incoming.id !== detail.id || incoming.fingerprint !== detail.fingerprint || incoming.decisionRevision !== detail.decisionRevision;
  const dirty = detail.statements.some(row => JSON.stringify(edits[row.id]) !== JSON.stringify(initialEdit(row)));
  useEffect(() => {
    if (!changed || (dirty && !awaiting)) return;
    setDetail(incoming);
    setSelectedId(current => incoming.statements.some(row => row.id === current) ? current : incoming.statements[0]?.id ?? "");
    setEdits(Object.fromEntries(incoming.statements.map(row => [row.id, initialEdit(row)])));
    setChoice(null);
    setError(null);
    savedIntent.current = null;
    if (awaiting) {
      setAwaiting(false);
      setNotice(savedChoice.current === "correct" ? "Correction saved. Review any remaining difference. Current CVs are unchanged."
        : "Decision saved. Current CVs and approved PDFs are unchanged.");
    } else setNotice(null);
  }, [awaiting, changed, dirty, incoming]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (window.confirm("Leave this review? Your unsaved correction will be lost.")) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", intercept, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", intercept, true); };
  }, [dirty, pending]);

  function updateEdit(id: string, next: Edit) { setEdits(current => ({ ...current, [id]: next })); setError(null); }
  async function save(nextChoice: Choice, statementId?: string) {
    if (pending || awaiting || changed || !detail.active) return;
    const selectedAssertionId = nextChoice === "choose" ? statementId : undefined;
    const selectedEdits = nextChoice === "keep_both_context" ? detail.statements.map(row => edits[row.id]!)
      : nextChoice === "correct" ? [edits[selectedId]!] : undefined;
    const intent = { conflictId: detail.id, expectedFingerprint: detail.fingerprint,
      expectedDecisionRevision: detail.decisionRevision, choice: nextChoice, selectedAssertionId, edits: selectedEdits };
    const signature = JSON.stringify(intent);
    const requestKey = savedIntent.current?.signature === signature ? savedIntent.current.key : crypto.randomUUID();
    savedIntent.current = { signature, key: requestKey };
    savedChoice.current = nextChoice;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await decide({ ...intent, requestKey });
      if (!result.ok) { setError(result.error); return; }
      setAwaiting(true);
      router.refresh();
    } catch {
      setError("We couldn't confirm this decision. Your entries are still here. Check the saved review before trying again.");
    } finally { setPending(false); }
  }

  const canEditBoth = detail.statements.length >= 2 && detail.statements.length <= 20;
  const controlsDisabled = pending || awaiting || changed || !detail.active;
  const showPublicWording = detail.effectiveConfidential || detail.statements.some(row => row.publicText !== null);
  return <section aria-label="Review conflicting Experience details" aria-busy={pending || awaiting} className="space-y-5">
    {!detail.active && <p role="status" className="border border-line-faint p-3 text-13">This past issue is no longer present in current Experience. Its statements and decisions remain in history.</p>}
    <div className="grid gap-3 md:grid-cols-2">{detail.statements.map((row, index) => <article key={row.id} className="min-w-0 border border-line-faint bg-raised p-4">
      <h3 className="text-16 font-semibold">Statement {index + 1}</h3>
      {detail.decision?.choice === "choose" && detail.decision.fingerprint === detail.fingerprint && detail.decision.selectedAssertionId === row.id &&
        <p className="mt-1 text-12 font-semibold text-ok">Used for future CVs</p>}
      <p className="mt-2 whitespace-pre-wrap break-words text-14">{row.text}</p>
      {row.context && <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
        <dt>Detail</dt><dd>{row.context.attribute}</dd><dt>Scope</dt><dd>{row.context.scope}</dd>
        <dt>Period</dt><dd>{row.context.period || "Not specified"}</dd><dt>Value</dt><dd>{row.context.value}</dd>
      </dl>}
      <p className="mt-3 text-12 text-muted">{sourceLabel(row)}</p>
      {row.provenance.quote && <blockquote className="mt-2 border-l-2 border-line-muted pl-3 text-12 text-muted">{row.provenance.quote}</blockquote>}
      {row.provenance.originalText !== row.text && <section className="mt-2 text-12"><h4 className="font-medium">Original wording</h4>
        <p className="whitespace-pre-wrap break-words text-muted">{row.provenance.originalText}</p></section>}
      <button type="button" className={`${buttonClass("secondary", "sm")} mt-4 w-full`} disabled={controlsDisabled}
        onClick={() => void save("choose", row.id)}>Use this statement for future CVs</button>
    </article>)}</div>
    <p className="text-13 text-muted">Choosing one keeps the other statements in Experience history. Existing CVs and approved PDFs do not change.</p>
    {detail.decision && <p role="status" className="text-13">{detail.decision.fingerprint !== detail.fingerprint
      ? "The statements changed since the last decision. Review them again."
      : `Saved decision: ${detail.decision.choice === "dismiss" ? "Not a conflict" : detail.decision.choice === "later" ? "Review later"
        : detail.decision.choice === "choose" ? "one statement selected for future CVs" : detail.decision.choice === "correct" ? "details corrected" : detail.decision.choice === "keep_both_context" ? "both statements have context" : "restored to review"}.`}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass("secondary", "sm")} disabled={controlsDisabled || !canEditBoth}
        onClick={() => setChoice("keep_both_context")}>Keep both with context</button>
      <button type="button" className={buttonClass("secondary", "sm")} disabled={controlsDisabled}
        onClick={() => setChoice("correct")}>Correct the details</button>
      <button type="button" className={buttonClass("secondary", "sm")} disabled={controlsDisabled}
        onClick={() => void save("dismiss")}>Not a conflict</button>
      <button type="button" className={buttonClass("secondary", "sm")} disabled={controlsDisabled}
        onClick={() => void save("later")}>Review later</button>
      {detail.decision?.choice === "later" && <button type="button" className={buttonClass("secondary", "sm")} disabled={controlsDisabled}
        onClick={() => void save("reopen")}>Restore to review</button>}
    </div>
    <p className="text-12 text-muted">“Not a conflict” keeps both facts available for future CVs; it does not guarantee both will be printed. “Review later” keeps the disputed detail out until you decide.</p>
    {choice === "keep_both_context" && <div className="space-y-3 border-t border-line-muted pt-4">
      <h3 className="font-semibold">Give each statement its own context</h3>
      <p className="text-13 text-muted">Keep both available by describing where or when each value applies.</p>
      {detail.statements.map((row, index) => <div key={row.id} className="space-y-2 border border-line-faint p-3">
        <h4 className="font-semibold">Statement {index + 1}</h4><ContextFields edit={edits[row.id]!} onChange={next => updateEdit(row.id, next)} prefix={`context-${row.id}`} disabled={controlsDisabled} />
        {showPublicWording && <><label htmlFor={`context-public-${row.id}`} className={labelClass}>Safe CV wording (optional)</label>
          <textarea id={`context-public-${row.id}`} className={inputClass} rows={2} maxLength={4000} disabled={controlsDisabled}
            value={edits[row.id]?.publicText ?? ""} onChange={event => updateEdit(row.id, { ...edits[row.id]!, publicText: event.target.value || null })} />
          <p className="text-12 text-muted">Only write what you are comfortable showing in a CV. Private client details stay in Experience.</p></>}
      </div>)}
      <button type="button" className={buttonClass("primary", "sm")} disabled={controlsDisabled || !canEditBoth}
        onClick={() => void save("keep_both_context")}>Save both contexts</button>
    </div>}
    {choice === "correct" && <div className="space-y-3 border-t border-line-muted pt-4">
      <h3 className="font-semibold">Correct one statement</h3>
      <label htmlFor="correct-statement" className={labelClass}>Statement to correct</label>
      <select id="correct-statement" className={inputClass} value={selectedId} disabled={controlsDisabled} onChange={event => setSelectedId(event.target.value)}>
        {detail.statements.map((row, index) => <option key={row.id} value={row.id}>Statement {index + 1}</option>)}
      </select>
      {edits[selectedId] && <><label htmlFor="correct-text" className={labelClass}>Correct wording</label>
        <textarea id="correct-text" className={inputClass} rows={4} maxLength={40000} disabled={controlsDisabled} value={edits[selectedId].text}
          onChange={event => updateEdit(selectedId, { ...edits[selectedId]!, text: event.target.value })} />
        <ContextFields edit={edits[selectedId]!} onChange={next => updateEdit(selectedId, next)} prefix={`correct-${selectedId}`} disabled={controlsDisabled} />
        {showPublicWording && <><label htmlFor="correct-public" className={labelClass}>Safe CV wording (optional)</label>
          <textarea id="correct-public" className={inputClass} rows={2} maxLength={4000} disabled={controlsDisabled} value={edits[selectedId].publicText ?? ""}
            onChange={event => updateEdit(selectedId, { ...edits[selectedId]!, publicText: event.target.value || null })} /></>}</>}
      <button type="button" className={buttonClass("primary", "sm")} disabled={controlsDisabled || !edits[selectedId]?.text.trim()}
        onClick={() => void save("correct")}>Save correction</button>
    </div>}
    {changed && <div role="alert" className="space-y-2 border border-warn p-3 text-13">
      <p>{incoming.id === detail.id ? "The saved statements changed" : "Another issue was opened"} while this review was open. Your draft is still here.</p>
      <button type="button" className="min-h-11 underline" onClick={() => {
        setDetail(incoming); setSelectedId(incoming.statements[0]?.id ?? "");
        setEdits(Object.fromEntries(incoming.statements.map(row => [row.id, initialEdit(row)])));
        setChoice(null); setError(null); setAwaiting(false); savedIntent.current = null;
      }}>Discard draft and open the updated review</button>
    </div>}
    {error && <div role="alert" className="text-13 text-danger">{error} <button type="button" className="min-h-11 underline" onClick={() => router.refresh()}>Refresh saved review</button></div>}
    {notice && <p role="status" className="text-13 text-ok">{notice}</p>}
    {awaiting && <p role="status" className="text-13 text-muted">Updating this review… <button type="button" className="min-h-11 underline" onClick={() => router.refresh()}>Refresh saved review</button></p>}
    <section className="border-t border-line-muted pt-3"><h3 className="text-13 font-semibold">Decision history</h3>
      <ol className="space-y-2 text-13">{detail.history.map(item => <li key={item.revision}>{new Date(item.createdAt).toLocaleString("en-GB")} · {item.choice === "dismiss" ? "Not a conflict" : item.choice === "later" ? "Review later" : item.choice === "reopen" ? "Restored to review" : item.choice === "choose" ? "Used one statement" : item.choice === "correct" ? "Corrected details" : "Kept both with context"}</li>)}</ol>
    </section>
  </section>;
}
