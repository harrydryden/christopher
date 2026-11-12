import type { CareerConflictDetail } from "@col/core/career-record";

/** The evidence can be read without loading decision editor JavaScript. */
export function CareerConflictSnapshot({ detail }: { detail: CareerConflictDetail }) {
  return <div className="space-y-5">
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
      <p className="mt-3 text-12 text-muted">{row.provenance.kind === "direct_user" ? "Added by you"
        : row.provenance.kind === "document" ? "From an imported document"
          : row.provenance.kind === "legacy_saved" ? "From earlier Experience" : "Suggestion"}</p>
      {row.provenance.quote && <blockquote className="mt-2 border-l-2 border-line-muted pl-3 text-12 text-muted">{row.provenance.quote}</blockquote>}
      {row.provenance.originalText !== row.text && <section className="mt-2 text-12"><h4 className="font-medium">Original wording</h4>
        <p className="whitespace-pre-wrap break-words text-muted">{row.provenance.originalText}</p></section>}
    </article>)}</div>
    {detail.decision && <p role="status" className="text-13">{detail.decision.fingerprint !== detail.fingerprint
      ? "The statements changed since the last decision. Review them again."
      : `Saved decision: ${detail.decision.choice === "dismiss" ? "Not a conflict" : detail.decision.choice === "later" ? "Review later"
        : detail.decision.choice === "choose" ? "one statement selected for future CVs" : detail.decision.choice === "correct" ? "details corrected" : detail.decision.choice === "keep_both_context" ? "both statements have context" : "restored to review"}.`}</p>}
    <section className="border-t border-line-muted pt-3"><h3 className="text-13 font-semibold">Decision history</h3>
      <ol className="space-y-2 text-13">{detail.history.map(item => <li key={item.revision}>{new Date(item.createdAt).toLocaleString("en-GB")} · {item.choice === "dismiss" ? "Not a conflict" : item.choice === "later" ? "Review later" : item.choice === "reopen" ? "Restored to review" : item.choice === "choose" ? "Used one statement" : item.choice === "correct" ? "Corrected details" : "Kept both with context"}</li>)}</ol>
    </section>
  </div>;
}
